// utils.js
// Shared utilities available to all content scripts

window.MyApotiUtils = {

  // ── Desktop app URL ──
  MYAPOTI_API: "http://localhost:8000",

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

  // ── Send data to desktop app ──
  // method defaults to POST. Pass "PUT" or "DELETE" for batch operations.
  // DELETE requests send no body.
  async sendToMyApoti(endpoint, payload, method = "POST") {
    const token = await this.getToken();
    if (!token) {
      console.log("MyApoti: Not logged in — skipping sync");
      return null;
    }

    const running = await this.isDesktopRunning();
    if (!running) {
      console.warn("MyApoti: Desktop app not running");
      chrome.runtime.sendMessage({ action: "desktop_offline" });
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