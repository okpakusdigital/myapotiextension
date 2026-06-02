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
    ],
    (data) => {
      if (data.myapoti_token) {
        showConnectedView(data);
        // ── Check RetailMan status after showing connected view ──
        checkRetailmanStatus(data.myapoti_token);
      }
    }
  );
}


// ── Setup all button listeners ──
function setupListeners() {

  // Login button
  document.getElementById("login-btn")
    .addEventListener("click", handleLogin);

  // Enter key on phone → focus password
  document.getElementById("phone")
    .addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        document.getElementById("password").focus();
      }
    });

  // Enter key on password → login
  document.getElementById("password")
    .addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleLogin();
    });

  // Password show/hide toggle
  document.getElementById("toggle-pw")
    .addEventListener("click", () => {
      const pw = document.getElementById("password");
      pw.type = pw.type === "password" ? "text" : "password";
    });

  // Sync Now button
  document.getElementById("sync-now-btn")
    ?.addEventListener("click", handleSyncNow);

  // Logout button
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


// ── Check RetailMan connector status from desktop API ──
async function checkRetailmanStatus(token) {
  try {
    const res = await fetch(`${DESKTOP_API}/connectors/settings`, {
      headers: { "Authorization": `Bearer ${token}` },
      signal: AbortSignal.timeout(4000),
    });

    if (!res.ok) return;

    const data = await res.json();
    const retailmanOn = data?.retailman?.enabled || false;

    // Save to storage so it persists between popup opens
    chrome.storage.local.set({
      retailman_active: retailmanOn,
      retailman_blocked_msg: retailmanOn
        ? "RetailMan sync is active in MyApoti. The extension is disabled while RetailMan is your inventory source. Disable RetailMan sync in MyApoti Settings to use the extension."
        : null,
    });

    // Update UI immediately
    applyRetailmanBlockState(retailmanOn, retailmanOn
      ? "RetailMan sync is active in MyApoti. Disable it in Settings → POS Connectors to use the extension."
      : null
    );

  } catch {
    // Non-fatal — desktop may be offline or endpoint not available
  }
}


// ── Apply RetailMan blocked state to UI ──
function applyRetailmanBlockState(isBlocked, message) {
  const banner  = document.getElementById("retailman-banner");
  const syncBtn = document.getElementById("sync-now-btn");

  if (isBlocked) {
    // Show warning banner
    if (banner) {
      banner.style.display = "block";
      const msgEl = document.getElementById("retailman-banner-msg");
      if (msgEl) msgEl.textContent = message || "RetailMan sync is active — extension disabled.";
    }
    // Disable sync button
    if (syncBtn) {
      syncBtn.disabled = true;
      syncBtn.title    = "Disabled — RetailMan sync is active in MyApoti";
      syncBtn.style.opacity = "0.5";
      syncBtn.style.cursor  = "not-allowed";
    }
  } else {
    // Hide banner, re-enable sync button
    if (banner) banner.style.display = "none";
    if (syncBtn) {
      syncBtn.disabled = false;
      syncBtn.title    = "Sync inventory now";
      syncBtn.style.opacity = "1";
      syncBtn.style.cursor  = "pointer";
    }
  }
}


// ── Handle login ──
async function handleLogin() {
  const phone    = document.getElementById("phone").value.trim();
  const password = document.getElementById("password").value.trim();
  const errorEl  = document.getElementById("login-error");
  const btn      = document.getElementById("login-btn");

  errorEl.textContent = "";

  if (!phone) {
    errorEl.textContent = "Please enter your phone number.";
    return;
  }

  if (!password) {
    errorEl.textContent = "Please enter your password.";
    return;
  }

  btn.disabled    = true;
  btn.textContent = "Connecting...";

  try {
    const res = await fetch(
      `${DESKTOP_API}/auth/login/pharmacy/`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone_number: phone,
          password,
        }),
        signal: AbortSignal.timeout(10000),
      }
    );

    if (res.ok) {
      const data = await res.json();

      chrome.storage.local.set({
        myapoti_token:        data.access_token,
        myapoti_phone:        phone,
        total_drugs_synced:   0,
        total_sales_captured: 0,
      });

      showConnectedView({
        myapoti_phone:        phone,
        last_sync:            null,
        total_drugs_synced:   0,
        total_sales_captured: 0,
      });

      // Check RetailMan status after login
      checkRetailmanStatus(data.access_token);

    } else {
      const err = await res.json().catch(() => ({}));
      errorEl.textContent = (
        err.detail || "Login failed. Check your credentials."
      );
    }

  } catch (err) {
    if (err.name === "TimeoutError") {
      errorEl.textContent = (
        "MyApoti Desktop not responding. " +
        "Is the app running?"
      );
    } else {
      errorEl.textContent = (
        "Cannot connect to MyApoti Desktop. " +
        "Please start the app first."
      );
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

  // Update badge
  const badge       = document.getElementById("badge");
  badge.textContent = "ON";
  badge.className   = "badge badge-on";

  // Show phone number
  document.getElementById("connected-email").textContent =
    data.myapoti_phone || "";

  // Show stats
  document.getElementById("drugs-synced").textContent =
    (data.total_drugs_synced || 0).toLocaleString();

  document.getElementById("sales-captured").textContent =
    (data.total_sales_captured || 0).toLocaleString();

  // Show last sync time
  if (data.last_sync) {
    const row = document.getElementById("last-sync-row");
    row.style.display = "block";
    document.getElementById("last-sync-time").textContent =
      new Date(data.last_sync).toLocaleString();
  }

  // Apply cached RetailMan block state immediately
  if (data.retailman_active) {
    applyRetailmanBlockState(true, data.retailman_blocked_msg);
  }
}


// ── Handle Sync Now ──
async function handleSyncNow() {
  const btn = document.getElementById("sync-now-btn");
  const msg = document.getElementById("sync-msg");

  btn.disabled    = true;
  btn.textContent = "Syncing...";
  msg.textContent = "";
  msg.style.color = "#28a745";

  chrome.tabs.query(
    { active: true, currentWindow: true },
    (tabs) => {
      if (!tabs[0]) {
        btn.disabled    = false;
        btn.textContent = "🔄 Sync Now";
        msg.textContent = "No active tab found.";
        msg.style.color = "#dc3545";
        return;
      }

      chrome.tabs.sendMessage(
        tabs[0].id,
        { action: "sync_now" },
        (response) => {
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

            // Refresh stats after 3 seconds
            setTimeout(() => {
              chrome.storage.local.get(
                [
                  "total_drugs_synced",
                  "total_sales_captured",
                  "last_sync",
                ],
                (data) => {
                  document.getElementById("drugs-synced")
                    .textContent =
                    (data.total_drugs_synced || 0).toLocaleString();

                  document.getElementById("sales-captured")
                    .textContent =
                    (data.total_sales_captured || 0).toLocaleString();

                  if (data.last_sync) {
                    const row = document.getElementById(
                      "last-sync-row"
                    );
                    row.style.display = "block";
                    document.getElementById("last-sync-time")
                      .textContent =
                      new Date(data.last_sync).toLocaleString();
                  }
                }
              );
            }, 3000);

          } else {
            msg.textContent = "Open the pharmacy app page to sync.";
            msg.style.color = "#856404";
          }
        }
      );
    }
  );
}


// ── Handle logout ──
function handleLogout() {
  if (!confirm("Disconnect your MyApoti account?")) return;
  chrome.storage.local.clear(() => location.reload());
}


// ── Detect active pharmacy app ──
function detectActivePharmacy() {
  chrome.tabs.query(
    { active: true, currentWindow: true },
    (tabs) => {
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
        if (url.includes(domain)) {
          detectedPlatform = name;
          break;
        }
      }

      if (detectedPlatform) {
        if (
          url.includes("drug")        ||
          url.includes("inventory")   ||
          title.includes("drug")      ||
          title.includes("inventory")
        ) {
          detectedPage = "📦 Inventory page";
        } else if (
          url.includes("billing")   ||
          url.includes("sales")     ||
          title.includes("billing")
        ) {
          detectedPage = "🧾 Billing page";
        } else if (
          url.includes("receive")   ||
          title.includes("receive")
        ) {
          detectedPage = "📥 Stock receipt page";
        } else {
          detectedPage = "🔍 Scanning...";
        }

        const banner = document.getElementById("active-banner");
        banner.style.display = "flex";

        document.getElementById("active-platform").textContent =
          `🟢 ${detectedPlatform}`;

        document.getElementById("active-page").textContent =
          detectedPage;
      }
    }
  );
}


// ── Listen for messages from background / content scripts ──
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "token_expired") {
    chrome.storage.local.clear(() => location.reload());
  }

  if (msg.action === "desktop_offline") {
    checkDesktopStatus();
  }

  // ── RetailMan became active mid-session ──
  if (msg.action === "retailman_active") {
    applyRetailmanBlockState(true, msg.message);
  }
});