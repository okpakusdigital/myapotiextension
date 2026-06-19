// utils.js
// Shared utilities available to all content scripts

window.MyApotiUtils = {

  // ── Desktop app URL ──
  MYAPOTI_API: "http://localhost:8000",

  // ── Buffer config ──
  // Operations that fail because the backend isn't reachable yet (desktop
  // app still booting) are queued here instead of being dropped. Stored in
  // chrome.storage.local (not a plain in-memory array) so the queue survives
  // a page navigation, tab close, or service worker restart — any of which
  // would wipe an in-memory buffer mid-wait.
  PENDING_QUEUE_KEY: "myapoti_pending_operations",
  RETRY_INTERVAL_MS: 5000,
  _retryTimer: null,

  // ── Check if desktop app is running ──
  async isDesktopRunning() {
    try {
      const res = await fetch(
        `${this.MYAPOTI_API}/health`,
        {
          method: "GET",
          signal: AbortSignal.timeout(3000),
        }
      );
      return res.ok;
    } catch {
      return false;
    }
  },

  // ── Get saved token from storage ──
  getToken() {
    return new Promise((resolve) => {
      chrome.storage.local.get("myapoti_token", (data) => {
        resolve(data.myapoti_token || null);
      });
    });
  },

  // ── Read the pending operations queue ──
  _getPendingQueue() {
    return new Promise((resolve) => {
      chrome.storage.local.get(this.PENDING_QUEUE_KEY, (data) => {
        resolve(Array.isArray(data[this.PENDING_QUEUE_KEY]) ? data[this.PENDING_QUEUE_KEY] : []);
      });
    });
  },

  // ── Write the pending operations queue ──
  _setPendingQueue(queue) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [this.PENDING_QUEUE_KEY]: queue }, resolve);
    });
  },

  // ── Add one operation to the queue ──
  async _enqueueOperation(endpoint, payload, method) {
    const queue = await this._getPendingQueue();
    queue.push({
      endpoint,
      payload,
      method,
      queued_at: Date.now(),
    });
    await this._setPendingQueue(queue);
    return queue.length;
  },

  // ── Retry every queued operation once the backend is reachable ──
  // Polls every RETRY_INTERVAL_MS. On each tick, checks the backend once;
  // if up, replays every queued operation in order via the real
  // sendToMyApoti (skipping the queue path since the backend is confirmed
  // reachable for this tick), then clears the queue. If any individual
  // operation fails for a non-connectivity reason (4xx/5xx), it is dropped
  // from the queue same as it would be on a normal call — only
  // connectivity failures get re-queued.
  startRetryLoop() {
    if (this._retryTimer) return; // already running

    this._retryTimer = setInterval(async () => {
      const queue = await this._getPendingQueue();
      if (queue.length === 0) {
        clearInterval(this._retryTimer);
        this._retryTimer = null;
        return;
      }

      const running = await this.isDesktopRunning();
      if (!running) {
        console.log(`MyApoti: Still offline — ${queue.length} operation(s) remain queued`);
        return;
      }

      // Backend is up — snapshot and clear the queue, then replay each
      // operation. Use _sendDirect (bypasses the queueing check) so a
      // mid-replay connectivity blip re-queues only what's left.
      await this._setPendingQueue([]);

      console.log(`MyApoti: Backend back online — replaying ${queue.length} queued operation(s)`);

      for (const op of queue) {
        await this._sendDirect(op.endpoint, op.payload, op.method, true);
      }

      const remaining = await this._getPendingQueue();
      if (remaining.length === 0) {
        clearInterval(this._retryTimer);
        this._retryTimer = null;
        chrome.runtime.sendMessage({ action: "desktop_back_online" });
        console.log("MyApoti: ✅ Queue fully flushed");
      } else {
        console.log(`MyApoti: ${remaining.length} operation(s) still queued after replay`);
      }
    }, this.RETRY_INTERVAL_MS);
  },

  // ── Send data to desktop app ──
  // method defaults to POST. Pass "PUT" or "DELETE" for batch operations.
  // DELETE requests send no body.
  //
  // If the backend isn't reachable, the operation is queued (instead of
  // dropped) and a retry loop is started to flush it automatically once
  // the backend comes online — covers every operation type that funnels
  // through here: sales, stock receipts, drug add/edit, drug delete,
  // batch update, batch delete.
  async sendToMyApoti(endpoint, payload, method = "POST") {
    return this._sendDirect(endpoint, payload, method, false);
  },

  // ── Internal — actual send logic ──
  // isReplay=true skips the queueing step on connectivity failure and
  // instead lets the caller (startRetryLoop) decide whether to re-queue,
  // preventing infinite recursion between sendToMyApoti and the retry loop.
  async _sendDirect(endpoint, payload, method, isReplay) {
    const token = await this.getToken();
    if (!token) {
      console.log("MyApoti: Not logged in — skipping sync");
      return null;
    }

    const running = await this.isDesktopRunning();
    if (!running) {
      console.warn("MyApoti: Desktop app not running");

      // ── Queue instead of dropping ──
      // Only queue on the original call, not during a replay tick — if a
      // replay attempt itself can't reach the backend, the outer
      // startRetryLoop already detected that via its own isDesktopRunning()
      // check and will simply try again next tick with the still-queued item.
      if (!isReplay) {
        const queueLength = await this._enqueueOperation(endpoint, payload, method);
        console.log(`MyApoti: Operation queued (${queueLength} pending) — will retry when desktop app is ready`);
        chrome.runtime.sendMessage({ action: "desktop_offline" });
        this.startRetryLoop();
      } else {
        // Replay hit a connectivity failure mid-batch — put it back.
        await this._enqueueOperation(endpoint, payload, method);
      }
      return null;
    }

    try {
      const res = await fetch(
        `${this.MYAPOTI_API}${endpoint}`,
        {
          method,
          headers: {
            "Content-Type":  "application/json",
            "Authorization": `Bearer ${token}`,
          },
          // DELETE requests must not include a body
          body: method === "DELETE" ? undefined : JSON.stringify(payload),
          signal: AbortSignal.timeout(15000),
        }
      );

      if (res.status === 401) {
        chrome.storage.local.remove("myapoti_token");
        chrome.runtime.sendMessage({ action: "token_expired" });
        console.log("MyApoti: Session expired — please reconnect");
        return null;
      }

      // ── 409 has two meanings — distinguish them ──
      //   A. RetailMan is active     → detail contains "RetailMan"
      //   B. Duplicate inventory     → detail contains "already exists"
      //   C. is_sync=True duplicate  → endpoint returns existing item (200)
      // Only show the RetailMan banner for case A.
      if (res.status === 409) {
        const err = await res.json().catch(() => ({}));
        const detail = err.detail || "";
        const isRetailmanBlock = detail.toLowerCase().includes("retailman");

        if (isRetailmanBlock) {
          console.warn("MyApoti: Extension blocked — RetailMan active:", detail);
          chrome.storage.local.set({
            retailman_active:      true,
            retailman_blocked_msg: detail,
          });
          chrome.runtime.sendMessage({
            action:  "retailman_active",
            message: detail,
          });
        } else {
          console.log("MyApoti: Item already exists in inventory —", detail || "duplicate");
          chrome.storage.local.set({ retailman_active: false });
        }
        return null;
      }

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error(
          `MyApoti API error ${res.status}:`,
          err.detail || "Unknown error"
        );
        return null;
      }

      // ── Successful response — clear any previous RetailMan block ──
      chrome.storage.local.set({ retailman_active: false, retailman_blocked_msg: null });

      const data = await res.json();

      chrome.storage.local.set({
        last_sync:        new Date().toISOString(),
        last_sync_result: data,
      });

      return data;

    } catch (err) {
      if (err.name === "TimeoutError") {
        console.error("MyApoti: Request timed out");
      } else {
        console.error("MyApoti: Request failed:", err.message);
      }
      return null;
    }
  },

  // ── Parse Nigerian price format ──
  parsePrice(text) {
    if (!text) return null;
    const cleaned = text
      .toString()
      .replace(/[₦,\s]/g, "")
      .replace(/[^0-9.]/g, "")
      .trim();
    const num = parseFloat(cleaned);
    return isNaN(num) || num <= 0 ? null : num;
  },

  // ── Parse date from various formats ──
  parseDate(text) {
    if (!text) return null;
    const str = text.toString().trim();
    const formats = [
      {
        r: /^(\d{2})\/(\d{2})\/(\d{4})$/,
        f: (m) => `${m[3]}-${m[2]}-${m[1]}`,
      },
      {
        r: /^(\d{4})-(\d{2})-(\d{2})$/,
        f: (m) => m[0],
      },
      {
        r: /^(\d{2})-(\d{2})-(\d{4})$/,
        f: (m) => `${m[3]}-${m[2]}-${m[1]}`,
      },
      {
        r: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
        f: (m) => `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`,
      },
    ];
    for (const { r, f } of formats) {
      const m = str.match(r);
      if (m) return f(m);
    }
    return null;
  },

  // ── Simple hash to detect data changes ──
  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return hash.toString();
  },

  // ── Wait for DOM element to appear ──
  waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);

      const obs = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          obs.disconnect();
          resolve(el);
        }
      });

      obs.observe(document.body, {
        childList: true,
        subtree:   true,
      });

      setTimeout(() => {
        obs.disconnect();
        reject(new Error(`Timeout: ${selector}`));
      }, timeout);
    });
  },

  // ── Update popup statistics ──
  updateStats(drugsAdded = 0, salesCaptured = 0) {
    chrome.storage.local.get(
      ["total_drugs_synced", "total_sales_captured"],
      (data) => {
        chrome.storage.local.set({
          total_drugs_synced:
            (data.total_drugs_synced || 0) + drugsAdded,
          total_sales_captured:
            (data.total_sales_captured || 0) + salesCaptured,
          last_sync: new Date().toISOString(),
        });
      }
    );
  },

  // ── Debounce helper ──
  debounce(fn, delay) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), delay);
    };
  },
};