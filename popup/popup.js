// popup.js

const DESKTOP_API = "http://localhost:8000";

document.addEventListener("DOMContentLoaded", () => {
  loadState();
  setupListeners();
  checkDesktopStatus();
  detectActivePharmacy();
});


// ── Load saved state ──
function loadState() {
  chrome.storage.local.get(
    [
      "myapoti_token",
      "myapoti_phone",
      "last_sync",
      "total_drugs_synced",
      "total_sales_captured",
      "retailman_active",
      "retailman_blocked_msg",
      "queue_pending",
      "queue_failed",
      "recent_syncs",
    ],
    (data) => {
      if (data.myapoti_token) {
        showConnectedView(data);
        checkRetailmanStatus(data.myapoti_token);
        updateQueueDisplay(data.queue_pending || 0, data.queue_failed || 0);
        updateRecentSyncs(data.recent_syncs || []);
        fetchInventoryStats(data.myapoti_token);
      }
    }
  );
}


// ── Setup all button listeners ──
function setupListeners() {
  document.getElementById("login-btn")
    .addEventListener("click", handleLogin);

  document.getElementById("phone")
    .addEventListener("keydown", (e) => {
      if (e.key === "Enter") document.getElementById("password").focus();
    });

  document.getElementById("password")
    .addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleLogin();
    });

  document.getElementById("toggle-pw")
    .addEventListener("click", () => {
      const pw = document.getElementById("password");
      pw.type = pw.type === "password" ? "text" : "password";
    });

  document.getElementById("sync-now-btn")
    ?.addEventListener("click", handleSyncNow);

  document.getElementById("logout-btn")
    ?.addEventListener("click", handleLogout);
}


// ── Check if desktop app is running ──
async function checkDesktopStatus() {
  const statusEl = document.getElementById("desktop-status");
  try {
    const res = await fetch(`${DESKTOP_API}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      statusEl.textContent        = "✅ MyApoti Desktop is running";
      statusEl.style.background   = "#d4edda";
      statusEl.style.color        = "#155724";
      statusEl.style.borderBottom = "1px solid #c3e6cb";
    } else {
      throw new Error("not ok");
    }
  } catch {
    statusEl.textContent        = "⚠️ MyApoti Desktop not running — please start the app";
    statusEl.style.background   = "#fff3cd";
    statusEl.style.color        = "#856404";
    statusEl.style.borderBottom = "1px solid #ffeeba";
  }
}


// ── Fetch live inventory stats from desktop API ──
async function fetchInventoryStats(token) {
  try {
    const res = await fetch(`${DESKTOP_API}/sync/progress`, {
      headers: { "Authorization": `Bearer ${token}` },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return;
    const data = await res.json();

    const drugsEl = document.getElementById("drugs-synced");
    if (drugsEl) drugsEl.textContent = (data.inventory_count || 0).toLocaleString();

    if (data.queue) {
      updateQueueDisplay(data.queue.pending || 0, data.queue.failed || 0);
    }
  } catch {}
}


// ── Format relative time ──
function timeAgo(iso) {
  if (!iso) return "";
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 5)  return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return new Date(iso).toLocaleDateString();
}


// ── Event type label + icon ──
function eventLabel(type) {
  switch (type) {
    case "added":   return { icon: "✅", label: "added" };
    case "updated": return { icon: "✏️", label: "updated" };
    case "sale":    return { icon: "🧾", label: "sold" };
    case "stock":   return { icon: "📥", label: "received" };
    case "deleted": return { icon: "🗑️", label: "deleted" };
    default:        return { icon: "✅", label: "synced" };
  }
}


// ── Update recently synced drugs feed ──
function updateRecentSyncs(syncs) {
  const container = document.getElementById("recent-syncs-list");
  const section   = document.getElementById("recent-syncs-section");
  if (!container || !section) return;

  if (!syncs || syncs.length === 0) {
    section.style.display = "none";
    return;
  }

  section.style.display = "block";
  container.innerHTML = "";

  // Show last 3 sync events
  syncs.slice(0, 3).forEach(entry => {
    const { icon, label } = eventLabel(entry.type);
    const names = entry.drugs || [];
    const count = entry.count || names.length;
    const time  = timeAgo(entry.timestamp);

    const eventDiv = document.createElement("div");
    eventDiv.style.cssText = "margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid #f1f5f9;";

    // Header: icon + count + time
    const header = document.createElement("div");
    header.style.cssText = "display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;";
    header.innerHTML = `
      <span style="font-size:0.76rem; font-weight:600; color:#374151;">
        ${icon} ${count} drug${count !== 1 ? "s" : ""} ${label}
      </span>
      <span style="font-size:0.70rem; color:#9ca3af;">${time}</span>
    `;
    eventDiv.appendChild(header);

    // Drug names list
    names.slice(0, 5).forEach(drugName => {
      const nameEl = document.createElement("div");
      nameEl.style.cssText = "font-size:0.73rem; color:#6b7280; padding-left:4px; line-height:1.6;";
      nameEl.textContent = drugName;
      eventDiv.appendChild(nameEl);
    });

    // "+N more" if truncated
    if (names.length > 5) {
      const moreEl = document.createElement("div");
      moreEl.style.cssText = "font-size:0.70rem; color:#9ca3af; padding-left:4px; font-style:italic;";
      moreEl.textContent = `+${names.length - 5} more`;
      eventDiv.appendChild(moreEl);
    }

    container.appendChild(eventDiv);
  });

  // Remove border from last item
  const items = container.querySelectorAll("div[style*='border-bottom']");
  if (items.length > 0) {
    items[items.length - 1].style.borderBottom = "none";
    items[items.length - 1].style.marginBottom = "0";
    items[items.length - 1].style.paddingBottom = "0";
  }
}


// ── Check RetailMan connector status ──
async function checkRetailmanStatus(token) {
  try {
    const res = await fetch(`${DESKTOP_API}/connectors/settings`, {
      headers: { "Authorization": `Bearer ${token}` },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return;
    const data = await res.json();
    const retailmanOn = data?.retailman?.enabled || false;

    chrome.storage.local.set({
      retailman_active: retailmanOn,
      retailman_blocked_msg: retailmanOn
        ? "RetailMan sync is active in MyApoti. The extension is disabled while RetailMan is your inventory source. Disable RetailMan sync in MyApoti Settings to use the extension."
        : null,
    });

    applyRetailmanBlockState(retailmanOn, retailmanOn
      ? "RetailMan sync is active in MyApoti. Disable it in Settings → POS Connectors to use the extension."
      : null
    );
  } catch {}
}


// ── Apply RetailMan blocked state ──
function applyRetailmanBlockState(isBlocked, message) {
  const banner  = document.getElementById("retailman-banner");
  const syncBtn = document.getElementById("sync-now-btn");

  if (isBlocked) {
    if (banner) {
      banner.style.display = "block";
      const msgEl = document.getElementById("retailman-banner-msg");
      if (msgEl) msgEl.textContent = message || "RetailMan sync is active — extension disabled.";
    }
    if (syncBtn) {
      syncBtn.disabled = true;
      syncBtn.title    = "Disabled — RetailMan sync is active in MyApoti";
      syncBtn.style.opacity = "0.5";
      syncBtn.style.cursor  = "not-allowed";
    }
  } else {
    if (banner) banner.style.display = "none";
    if (syncBtn) {
      syncBtn.disabled = false;
      syncBtn.title    = "Sync inventory now";
      syncBtn.style.opacity = "1";
      syncBtn.style.cursor  = "pointer";
    }
  }
}


// ── Update cloud sync queue display ──
function updateQueueDisplay(pending, failed) {
  const pendingRow   = document.getElementById("queue-status-row");
  const failedRow    = document.getElementById("queue-failed-row");
  const pendingCount = document.getElementById("queue-pending-count");
  const failedCount  = document.getElementById("queue-failed-count");

  if (!pendingRow || !failedRow) return;

  if (pending > 0) {
    pendingRow.style.display = "block";
    if (pendingCount) pendingCount.textContent = pending;
  } else {
    pendingRow.style.display = "none";
  }

  if (failed > 0) {
    failedRow.style.display = "block";
    if (failedCount) failedCount.textContent = failed;
  } else {
    failedRow.style.display = "none";
  }
}


// ── Handle login ──
async function handleLogin() {
  const phone    = document.getElementById("phone").value.trim();
  const password = document.getElementById("password").value.trim();
  const errorEl  = document.getElementById("login-error");
  const btn      = document.getElementById("login-btn");

  errorEl.textContent = "";
  if (!phone)    { errorEl.textContent = "Please enter your phone number."; return; }
  if (!password) { errorEl.textContent = "Please enter your password."; return; }

  btn.disabled    = true;
  btn.textContent = "Connecting...";

  try {
    const res = await fetch(`${DESKTOP_API}/auth/login/pharmacy/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone_number: phone, password }),
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      const data = await res.json();
      chrome.storage.local.set({
        myapoti_token:        data.access_token,
        myapoti_phone:        phone,
        total_drugs_synced:   0,
        total_sales_captured: 0,
        queue_pending:        0,
        queue_failed:         0,
      });

      showConnectedView({
        myapoti_phone:        phone,
        last_sync:            null,
        total_drugs_synced:   0,
        total_sales_captured: 0,
      });

      updateQueueDisplay(0, 0);
      checkRetailmanStatus(data.access_token);
      fetchInventoryStats(data.access_token);

    } else {
      const err = await res.json().catch(() => ({}));
      errorEl.textContent = err.detail || "Login failed. Check your credentials.";
    }
  } catch (err) {
    if (err.name === "TimeoutError") {
      errorEl.textContent = "MyApoti Desktop not responding. Is the app running?";
    } else {
      errorEl.textContent = "Cannot connect to MyApoti Desktop. Please start the app first.";
    }
  } finally {
    btn.disabled    = false;
    btn.textContent = "🔗 Connect to MyApoti";
  }
}


// ── Show connected view ──
function showConnectedView(data) {
  document.getElementById("login-view").style.display     = "none";
  document.getElementById("connected-view").style.display = "block";

  const badge       = document.getElementById("badge");
  badge.textContent = "ON";
  badge.className   = "badge badge-on";

  document.getElementById("connected-email").textContent = data.myapoti_phone || "";

  document.getElementById("drugs-synced").textContent =
    (data.total_drugs_synced || 0).toLocaleString();

  document.getElementById("sales-captured").textContent =
    (data.total_sales_captured || 0).toLocaleString();

  if (data.last_sync) {
    const row = document.getElementById("last-sync-row");
    row.style.display = "block";
    document.getElementById("last-sync-time").textContent =
      new Date(data.last_sync).toLocaleString();
  }

  if (data.retailman_active) {
    applyRetailmanBlockState(true, data.retailman_blocked_msg);
  }

  // ── Load recent syncs and live count ──
  chrome.storage.local.get(["myapoti_token", "recent_syncs"], ({ myapoti_token, recent_syncs }) => {
    updateRecentSyncs(recent_syncs || []);
    if (myapoti_token) fetchInventoryStats(myapoti_token);
  });
}


// ── Handle Sync Now ──
async function handleSyncNow() {
  const btn = document.getElementById("sync-now-btn");
  const msg = document.getElementById("sync-msg");

  btn.disabled    = true;
  btn.textContent = "Syncing...";
  msg.textContent = "";
  msg.style.color = "#28a745";

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) {
      btn.disabled    = false;
      btn.textContent = "🔄 Sync Now";
      msg.textContent = "No active tab found.";
      msg.style.color = "#dc3545";
      return;
    }

    chrome.tabs.sendMessage(tabs[0].id, { action: "sync_now" }, (response) => {
      btn.disabled    = false;
      btn.textContent = "🔄 Sync Now";

      if (chrome.runtime.lastError) {
        msg.textContent = "Open your pharmacy app to sync.";
        msg.style.color = "#856404";
        return;
      }

      if (response?.success) {
        msg.textContent = "✅ Sync triggered successfully!";
        msg.style.color = "#28a745";

        setTimeout(() => {
          chrome.storage.local.get(
            ["myapoti_token", "total_sales_captured", "last_sync",
             "queue_pending", "queue_failed", "recent_syncs"],
            (data) => {
              document.getElementById("sales-captured").textContent =
                (data.total_sales_captured || 0).toLocaleString();

              if (data.last_sync) {
                const row = document.getElementById("last-sync-row");
                row.style.display = "block";
                document.getElementById("last-sync-time").textContent =
                  new Date(data.last_sync).toLocaleString();
              }

              updateQueueDisplay(data.queue_pending || 0, data.queue_failed || 0);
              updateRecentSyncs(data.recent_syncs || []);
              if (data.myapoti_token) fetchInventoryStats(data.myapoti_token);
            }
          );
        }, 3000);

      } else {
        msg.textContent = "Open the pharmacy app page to sync.";
        msg.style.color = "#856404";
      }
    });
  });
}


// ── Handle logout ──
function handleLogout() {
  if (!confirm("Disconnect your MyApoti account?")) return;
  chrome.storage.local.clear(() => location.reload());
}


// ── Detect active pharmacy app ──
function detectActivePharmacy() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;

    const url   = (tabs[0].url   || "").toLowerCase();
    const title = (tabs[0].title || "").toLowerCase();

    const platforms = {
      "healthstation.ng": "Dulos HMIS",
      "virtualrx.ng":     "VirtualRx",
      "medpoint":         "MedPoint",
      "quickpharm":       "QuickPharm",
      "pharmsoft":        "PharmaSoft",
    };

    let detectedPlatform = null;
    let detectedPage     = null;

    for (const [domain, name] of Object.entries(platforms)) {
      if (url.includes(domain)) { detectedPlatform = name; break; }
    }

    if (detectedPlatform) {
      if (url.includes("drug") || url.includes("inventory") || title.includes("drug") || title.includes("inventory")) {
        detectedPage = "📦 Inventory page";
      } else if (url.includes("billing") || url.includes("sales") || title.includes("billing")) {
        detectedPage = "🧾 Billing page";
      } else if (url.includes("receive") || title.includes("receive")) {
        detectedPage = "📥 Stock receipt page";
      } else {
        detectedPage = "🔍 Scanning...";
      }

      const banner = document.getElementById("active-banner");
      banner.style.display = "flex";
      document.getElementById("active-platform").textContent = `🟢 ${detectedPlatform}`;
      document.getElementById("active-page").textContent = detectedPage;
    }
  });
}


// ── Listen for messages from background / content scripts ──
chrome.runtime.onMessage.addListener((msg) => {

  // ── Normalise message field — content.js sends { type, ...data }
  //    while other senders use { action, ...data }. Support both.
  const event = msg.action || msg.type;

  if (event === "token_expired") {
    chrome.storage.local.clear(() => location.reload());
  }

  // ── Desktop app not reachable — refresh the status banner so the
  //    user sees the warning immediately, not just on next popup open.
  if (event === "desktop_offline") {
    checkDesktopStatus();
  }

  // ── Buffer flushed — backend is back up. Refresh status banner and
  //    live stats so the popup reflects the successful sync immediately.
  if (event === "desktop_back_online") {
    checkDesktopStatus();
    chrome.storage.local.get(["myapoti_token", "recent_syncs"], ({ myapoti_token, recent_syncs }) => {
      updateRecentSyncs(recent_syncs || []);
      if (myapoti_token) fetchInventoryStats(myapoti_token);
    });
  }

  if (event === "retailman_active") {
    applyRetailmanBlockState(true, msg.message);
  }

  if (event === "queue_status_update") {
    const pending = msg.queue_pending || 0;
    const failed  = msg.queue_failed  || 0;

    updateQueueDisplay(pending, failed);
    chrome.storage.local.set({ queue_pending: pending, queue_failed: failed });

    if (msg.drug_names && msg.drug_names.length > 0) {
      chrome.storage.local.get("recent_syncs", ({ recent_syncs }) => {
        updateRecentSyncs(recent_syncs || []);
      });
    }

    chrome.storage.local.get("myapoti_token", ({ myapoti_token }) => {
      if (myapoti_token) fetchInventoryStats(myapoti_token);
    });
  }

  if (event === "inventory_updated") {
    chrome.storage.local.get(["myapoti_token", "recent_syncs"], ({ myapoti_token, recent_syncs }) => {
      updateRecentSyncs(recent_syncs || []);
      if (myapoti_token) fetchInventoryStats(myapoti_token);
    });
  }
});