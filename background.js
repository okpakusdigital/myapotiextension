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

  if (msg.action === "desktop_offline") {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#ffc107" });
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