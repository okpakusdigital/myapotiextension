// universal.js
// Main content script — runs on every page
// Orchestrates detection, reading, and syncing

(function () {
  "use strict";

  const utils    = window.MyApotiUtils;
  const detector = window.MyApotiDetector;

  // ── Initialize after page loads ──
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    setTimeout(init, 1500);
  }

  // ── Re-run on URL changes (SPA navigation) ──
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(init, 1500);
    }
  }).observe(document, { subtree: true, childList: true });


  function init() {
    if (!detector.isPharmacyApp()) return;

    const pageType = detector.detectPageType();
    const platform = detector.getPlatformName();

    console.log(
      `%cMyApoti Sync%c Active on ${platform} — ${pageType}`,
      "background:#007bff;color:#fff;padding:2px 6px;" +
      "border-radius:3px;font-weight:bold",
      "color:#333"
    );

    // ── Notify background script ──
    chrome.runtime.sendMessage({
      action:   "pharmacy_detected",
      pageType,
      platform,
      url:      location.href,
    });

    // ── Handle page based on type ──
    switch (pageType) {
      case "inventory":
        handleInventoryPage();
        break;
      case "billing":
        handleBillingPage();
        break;
      case "stock_receipt":
        handleStockReceiptPage();
        break;
      case "add_edit_drug":
        handleAddEditDrugPage();
        break;
      default:
        handleInventoryPage(true);
    }

    // ── Listen for manual sync from popup ──
    chrome.runtime.onMessage.addListener(
      (msg, sender, sendResponse) => {
        if (msg.action === "sync_now") {
          forceSync();
          sendResponse({ success: true });
        }
      }
    );
  }


  // ═══════════════════════════════════════
  // INVENTORY PAGE
  // ═══════════════════════════════════════

  function handleInventoryPage(silent = false) {
    utils.waitForElement("table tbody tr")
      .then(() => {
        setTimeout(() => syncInventory(false, silent), 1000);
      })
      .catch(() => {
        setTimeout(() => tryCardLayout(silent), 2000);
      });

    const debouncedSync = utils.debounce(
      () => syncInventory(false, true), 2000
    );

    new MutationObserver(debouncedSync).observe(
      document.body,
      { childList: true, subtree: true }
    );
  }

  function syncInventory(force = false, silent = false) {
    const tables = document.querySelectorAll("table");
    if (!tables.length) {
      tryCardLayout(silent);
      return;
    }

    let bestTable      = null;
    let bestConfidence = 0;

    tables.forEach((table) => {
      const reader = new window.SmartTableReader(table);
      if (
        reader.isInventoryTable() &&
        reader.confidence > bestConfidence
      ) {
        bestConfidence = reader.confidence;
        bestTable      = table;
      }
    });

    if (!bestTable || bestConfidence < 15) {
      if (!silent) {
        console.log("MyApoti: No inventory table detected");
      }
      tryCardLayout(silent);
      return;
    }

    const reader = new window.SmartTableReader(bestTable);
    const { drugs, confidence } = reader.readRows();

    if (!drugs.length) return;

    if (!silent) {
      console.log(
        `MyApoti: Found ${drugs.length} drugs ` +
        `(confidence: ${confidence}%)`
      );
    }

    const currentHash = utils.hashString(
      JSON.stringify(drugs)
    );

    chrome.storage.local.get(
      "inventory_hash",
      ({ inventory_hash }) => {
        if (!force && inventory_hash === currentHash) {
          if (!silent) {
            console.log("MyApoti: No changes — skipping");
          }
          return;
        }

        utils.sendToMyApoti(
          "/pharmacies/sync-from-extension",
          {
            source:     detector.getPlatformName(),
            drugs,
            confidence,
          }
        ).then((result) => {
          if (result) {
            chrome.storage.local.set({
              inventory_hash: currentHash,
            });
            utils.updateStats(result.added || 0, 0);
            console.log(
              `%cMyApoti%c Synced — ` +
              `${result.added} added, ` +
              `${result.updated} updated`,
              "background:#28a745;color:#fff;" +
              "padding:2px 6px;border-radius:3px",
              "color:#333"
            );
          }
        });
      }
    );
  }

  function tryCardLayout(silent = false) {
    const selectors = [
      ".product-card", ".inventory-card",
      ".drug-card", ".item-card",
      "[class*='product-item']",
      "[class*='inventory-item']",
      "[class*='drug-item']",
    ];

    for (const sel of selectors) {
      const cards = document.querySelectorAll(sel);
      if (cards.length >= 3) {
        const drugs = readCardsIntelligently(cards);
        if (drugs.length) {
          if (!silent) {
            console.log(
              `MyApoti: Found ${drugs.length} drugs in cards`
            );
          }
          syncDrugsDirectly(drugs);
          return;
        }
      }
    }
  }

  function readCardsIntelligently(cards) {
    const drugs = [];

    cards.forEach((card) => {
      const name = findTextIn(card, [
        "[class*='name']", "[class*='title']",
        "h3", "h4", "h5", "strong",
        "[class*='product']", "[class*='drug']",
      ]);
      if (!name) return;

      const price = utils.parsePrice(
        findTextIn(card, [
          "[class*='price']", "[class*='amount']",
          "[class*='rate']", "[class*='cost']",
        ])
      );
      if (!price) return;

      const qtyText = findTextIn(card, [
        "[class*='qty']", "[class*='quantity']",
        "[class*='stock']", "[class*='available']",
      ]);
      const quantity = parseInt(
        (qtyText || "0").replace(/[^0-9]/g, "") || "0"
      );

      drugs.push({ generic_name: name, quantity, price });
    });

    return drugs;
  }

  function findTextIn(parent, selectors) {
    for (const sel of selectors) {
      const el = parent.querySelector(sel);
      if (el?.innerText?.trim()) return el.innerText.trim();
    }
    return null;
  }

  function syncDrugsDirectly(drugs, force = false) {
    const currentHash = utils.hashString(
      JSON.stringify(drugs)
    );
    chrome.storage.local.get(
      "inventory_hash",
      ({ inventory_hash }) => {
        if (!force && inventory_hash === currentHash) return;

        utils.sendToMyApoti(
          "/pharmacies/sync-from-extension",
          {
            source:     detector.getPlatformName(),
            drugs,
            confidence: 50,
          }
        ).then((result) => {
          if (result) {
            chrome.storage.local.set({
              inventory_hash: currentHash,
            });
            utils.updateStats(result.added || 0, 0);
          }
        });
      }
    );
  }


  // ═══════════════════════════════════════
  // BILLING PAGE
  // ═══════════════════════════════════════

  function handleBillingPage() {
    console.log("MyApoti: Billing page — watching for sales");

    document.addEventListener("click", (e) => {
      const btn = e.target.closest(
        "button, [role='button'], input[type='submit']"
      );
      if (!btn) return;

      const text = (
        btn.innerText + btn.value + btn.className
      ).toLowerCase();

      const isSaleAction = [
        "complete sale", "confirm sale", "sell",
        "pay", "checkout", "dispense", "submit",
        "place order", "process payment", "finalize",
      ].some(kw => text.includes(kw));

      if (isSaleAction) {
        console.log("MyApoti: Sale action detected");
        setTimeout(captureSale, 2000);
      }
    }, true);

    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          const content = (
            (node.innerText || "") +
            (node.className || "")
          ).toLowerCase();

          if ([
            "sale successful", "payment successful",
            "receipt", "dispensed",
            "transaction complete", "sale complete",
          ].some(kw => content.includes(kw))) {
            setTimeout(captureSale, 500);
            return;
          }
        }
      }
    }).observe(document.body, {
      childList: true,
      subtree:   true,
    });
  }

  function captureSale() {
    const tables   = document.querySelectorAll("table");
    let saleItems  = [];

    tables.forEach((table) => {
      const reader = new window.SmartTableReader(table);
      if (reader.isBillingTable() || reader.confidence > 20) {
        const rows = table.querySelectorAll("tbody tr");
        rows.forEach((row) => {
          const cells = row.querySelectorAll("td");
          if (cells.length < 2) return;

          const name = cells[0]?.innerText?.trim();
          if (!name) return;

          const qty = parseInt(
            (
              cells[1]?.innerText ||
              cells[2]?.innerText ||
              "1"
            ).replace(/[^0-9]/g, "") || "1"
          );

          const price = utils.parsePrice(
            cells[2]?.innerText || cells[3]?.innerText
          );

          if (name && qty > 0) {
            saleItems.push({
              name,
              quantity_sold: qty,
              unit_price:    price,
            });
          }
        });
      }
    });

    if (!saleItems.length) return;

    const saleHash = utils.hashString(
      JSON.stringify(saleItems)
    );

    chrome.storage.local.get(
      "last_sale_hash",
      ({ last_sale_hash }) => {
        if (last_sale_hash === saleHash) return;

        chrome.storage.local.set({
          last_sale_hash: saleHash,
          last_sale_time: Date.now(),
        });

        console.log(
          `MyApoti: Capturing sale — ${saleItems.length} items`
        );

        utils.sendToMyApoti(
          "/pharmacies/sync-sale-from-extension",
          {
            source:   detector.getPlatformName(),
            items:    saleItems,
            sold_at:  new Date().toISOString(),
          }
        ).then((result) => {
          if (result) {
            utils.updateStats(0, 1);
            console.log(
              `MyApoti: Sale synced — ` +
              `${result.deducted} items deducted`
            );
          }
        });
      }
    );
  }


  // ═══════════════════════════════════════
  // STOCK RECEIPT PAGE
  // ═══════════════════════════════════════

  function handleStockReceiptPage() {
    console.log("MyApoti: Stock receipt page — watching");

    document.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;

      const text = btn.innerText?.toLowerCase() || "";
      if ([
        "receive", "accept", "confirm",
        "save", "approve",
      ].some(kw => text.includes(kw))) {
        setTimeout(captureStockReceipt, 1500);
      }
    }, true);
  }

  function captureStockReceipt() {
    const tables = document.querySelectorAll("table");
    const items  = [];

    tables.forEach((table) => {
      const reader = new window.SmartTableReader(table);
      if (reader.confidence > 15) {
        const { drugs } = reader.readRows();
        drugs.forEach((drug) => {
          if (drug.quantity > 0) {
            items.push({
              name:              drug.generic_name ||
                                 drug.brand_name,
              quantity_received: drug.quantity,
            });
          }
        });
      }
    });

    if (!items.length) return;

    utils.sendToMyApoti(
      "/pharmacies/sync-stock-receipt-from-extension",
      {
        source:      detector.getPlatformName(),
        items,
        received_at: new Date().toISOString(),
      }
    ).then((result) => {
      if (result) {
        console.log(
          `MyApoti: Stock receipt — ${result.updated} updated`
        );
      }
    });
  }


  // ═══════════════════════════════════════
  // ADD / EDIT DRUG PAGE
  // ═══════════════════════════════════════

  function handleAddEditDrugPage() {
    console.log("MyApoti: Add/Edit drug page — watching");

    document.addEventListener("click", (e) => {
      const btn = e.target.closest(
        "button, input[type='submit']"
      );
      if (!btn) return;

      const text = (
        btn.innerText + btn.value
      ).toLowerCase();

      if ([
        "save", "add", "submit", "create", "update",
      ].some(kw => text.includes(kw))) {
        const form = document.querySelector("form");
        if (form) setTimeout(() => captureForm(form), 800);
      }
    }, true);

    document.addEventListener("submit", (e) => {
      setTimeout(() => captureForm(e.target), 500);
    }, true);
  }

  function captureForm(form) {
    const reader = new window.SmartFormReader(form);
    const values = reader.readValues();

    const name  = values.generic_name || values.brand_name;
    const price = utils.parsePrice(values.price);

    if (!name || !price) return;

    utils.sendToMyApoti(
      "/pharmacies/sync-from-extension",
      {
        source:     detector.getPlatformName(),
        confidence: 80,
        drugs: [{
          generic_name:    values.generic_name || name,
          brand_name:      values.brand_name,
          quantity:        parseInt(values.quantity || "0"),
          price,
          cost_price:      utils.parsePrice(values.cost_price),
          category:        values.category,
          strength:        values.strength,
          dosage_form:     values.dosage_form,
          expiration_date: utils.parseDate(values.expiry_date),
          nafdac_number:   values.barcode,
        }],
      }
    );
  }


  // ═══════════════════════════════════════
  // FORCE SYNC
  // ═══════════════════════════════════════

  function forceSync() {
    chrome.storage.local.remove("inventory_hash", () => {
      syncInventory(true, false);
    });
  }

})();