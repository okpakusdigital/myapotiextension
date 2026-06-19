// background.js — service worker

// ── Handle messages from content scripts ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.action === "pharmacy_detected") {
    chrome.action.setBadgeText({
      text: "ON",
      tabId: sender.tab?.id,
    });
    chrome.action.setBadgeBackgroundColor({
      color: "#28a745",
      tabId: sender.tab?.id,
    });
    chrome.action.setTitle({
      title: `MyApoti Sync — Active on ${msg.platform}`,
      tabId: sender.tab?.id,
    });
  }

  // ── content.js's notifyBackground() sends { type, ...data }, not
  //    { action, ...data } — check both fields so this fires correctly
  //    regardless of which the sender used.
  if (msg.action === "desktop_offline" || msg.type === "desktop_offline") {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#ffc107" });
  }

  // ── Backend came back online and the buffered drug batch was flushed —
  //    clear the "!" badge set above.
  if (msg.action === "desktop_back_online" || msg.type === "desktop_back_online") {
    chrome.action.setBadgeText({ text: "", tabId: sender.tab?.id });
  }

  if (msg.action === "token_expired") {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#dc3545" });
  }

  sendResponse({ received: true });
  return true;
});

// ── Clear badge when tab navigates away ──
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    chrome.action.setBadgeText({ text: "", tabId });
  }
});

// ── Keep service worker alive ──
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  // keeps worker alive
});