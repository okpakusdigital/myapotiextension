// content_scripts/universal.js
// Runs at document_idle — after DOM is ready.
// Orchestrates two sync paths:
//
//   Path 1 — Request interception (primary, most reliable):
//     Listens for "myapoti_capture" CustomEvent fired by interceptor.js.
//     Receives server-confirmed sale/stock/drug data.
//     Formats and sends to MyApoti API.
//
//   Path 2 — DOM scraping (fallback for inventory pages):
//     Reads inventory tables using SmartTableReader.
//     Used when pharmacist navigates to the drug register.
//     Less reliable than interception but covers read-only pages
//     that don't fire POST requests (no sale happening).

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

    chrome.runtime.sendMessage({
      action: "pharmacy_detected",
      pageType,
      platform,
      url: location.href,
    });

    // ── Path 2: DOM scraping for inventory pages ──
    if (pageType === "inventory") {
      handleInventoryPage();
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


  // ══════════════════════════════════════════════════════
  // PATH 1 — REQUEST INTERCEPTION HANDLER
  // ══════════════════════════════════════════════════════

  window.addEventListener("myapoti_capture", (e) => {
    const { type, url, payload } = e.detail;

    if (type === "sale") {
      handleCapturedSale(url, payload);
    } else if (type === "stock_receipt") {
      handleCapturedStockReceipt(url, payload);
    } else if (type === "drug") {
      if (payload?.request?.__delete) {
        handleCapturedDelete(url, payload);
      } else {
        handleCapturedDrug(url, payload);
      }
    } else if (type === "batch_update") {
      handleCapturedBatchUpdate(url, payload);
    } else if (type === "batch_delete") {
      handleCapturedBatchDelete(url, payload);
    }
  });


  // ── Captured sale handler ──
  function handleCapturedSale(url, payload) {
    const items = extractSaleItems(payload);
    if (!items.length) return;

    const saleHash = utils.hashString(JSON.stringify(items));
    const now = Date.now();

    // Dedup window: 5 seconds — prevents double-fire from SPA re-renders
    // but always allows a new sale after 5 seconds even if items are identical
    const DEDUP_WINDOW_MS = 5000;

    chrome.storage.local.get(["last_sale_hash", "last_sale_time"], ({ last_sale_hash, last_sale_time }) => {
      const timeSinceLast = now - (last_sale_time || 0);
      const isDuplicate = last_sale_hash === saleHash && timeSinceLast < DEDUP_WINDOW_MS;

      if (isDuplicate) {
        console.log(`MyApoti: Sale duplicate suppressed (${timeSinceLast}ms since last — within ${DEDUP_WINDOW_MS}ms window)`);
        return;
      }

      chrome.storage.local.set({
        last_sale_hash: saleHash,
        last_sale_time: now,
      });

      console.log(`MyApoti: Sale confirmed by server — ${items.length} items`);

      utils.sendToMyApoti("/extension/sync-sale", {
        source:   detector.getPlatformName(),
        items,
        sold_at:  new Date().toISOString(),
        raw_url:  url,
      }).then(result => {
        if (result) {
          utils.updateStats(0, 1);
          console.log(
            `%cMyApoti%c Sale synced — ${result.deducted || 0} items deducted`,
            "background:#28a745;color:#fff;padding:2px 6px;border-radius:3px",
            "color:#333"
          );
        }
      });
    });
  }


  // ── Extract sale items from HMIS payload ──
  function extractSaleItems(payload) {
    const sources = [
      payload?.response,
      payload?.request,
    ];

    for (const source of sources) {
      if (!source) continue;

      const candidates = [
        source?.items,
        source?.drugs,
        source?.products,
        source?.line_items,
        source?.cart,
        source?.sales_items,
        source?.dispensed_items,
        source?.data?.items,
        source?.sale?.items,
        source?.transaction?.items,
        source?.billing?.items,
        source?.order?.items,
      ];

      for (const candidate of candidates) {
        if (Array.isArray(candidate) && candidate.length) {
          const mapped = candidate.map(item => ({
            name: (
              item.name          ||
              item.drug_name     ||
              item.product_name  ||
              item.description   ||
              item.item_name     ||
              item.medicine_name ||
              ""
            ).trim(),
            quantity_sold: parseInt(
              item.quantity      ||
              item.qty           ||
              item.quantity_sold ||
              item.dispensed_qty ||
              1
            ),
            unit_price: utils.parsePrice(
              item.price         ||
              item.unit_price    ||
              item.selling_price ||
              item.amount        ||
              item.rate          ||
              "0"
            ),
          })).filter(i => i.name && i.quantity_sold > 0);

          if (mapped.length) return mapped;
        }
      }

      const name = (
        source?.name          ||
        source?.drug_name     ||
        source?.product_name  ||
        ""
      ).trim();

      if (name) {
        return [{
          name,
          quantity_sold: parseInt(source?.quantity || source?.qty || 1),
          unit_price:    utils.parsePrice(source?.price || source?.unit_price || "0"),
        }];
      }
    }

    return [];
  }


  // ── Captured stock receipt handler ──
  function handleCapturedStockReceipt(url, payload) {
    const items = extractStockItems(payload);
    if (!items.length) return;

    console.log(`MyApoti: Stock receipt confirmed — ${items.length} items`);

    utils.sendToMyApoti("/extension/sync-stock-receipt", {
      source:      detector.getPlatformName(),
      items,
      received_at: new Date().toISOString(),
      raw_url:     url,
    }).then(result => {
      if (result) {
        console.log(
          `MyApoti: Stock receipt synced — ${result.updated || 0} updated`
        );
      }
    });
  }


  function extractStockItems(payload) {
    const sources = [payload?.response, payload?.request];

    for (const source of sources) {
      if (!source) continue;

      const candidates = [
        source?.items,
        source?.drugs,
        source?.products,
        source?.received_items,
        source?.stock_items,
        source?.data?.items,
      ];

      for (const candidate of candidates) {
        if (Array.isArray(candidate) && candidate.length) {
          return candidate.map(item => ({
            name: (
              item.name         ||
              item.drug_name    ||
              item.product_name ||
              item.description  ||
              ""
            ).trim(),
            quantity_received: parseInt(
              item.quantity          ||
              item.qty               ||
              item.quantity_received ||
              item.received_qty      ||
              0
            ),
            batch_number:    item.batch_number    || item.batch_no    || item.lot_number || null,
            expiration_date: item.expiration_date || item.expiry_date || item.expiry     || null,
            nafdac_number:   item.nafdac_number   || item.nafdac      || item.reg_no     || null,
          })).filter(i => i.name && i.quantity_received > 0);
        }
      }
    }

    return [];
  }


  function extractBatches(payload) {
    const sources = [payload?.response, payload?.request];
    for (const source of sources) {
      if (!source) continue;
      const candidates = [
        source?.batches,
        source?.batch_items,
        source?.stock_batches,
        source?.drug?.batches,
        source?.data?.batches,
      ];
      for (const candidate of candidates) {
        if (Array.isArray(candidate) && candidate.length) {
          return candidate.map(b => ({
            batch_number:    b.batch_no     || b.batch_number || b.lot_number  || b.lot_no || null,
            quantity:        parseInt(b.quantity || b.qty || 0),
            expiration_date: utils.parseDate(b.expiry || b.expiry_date || b.expiration_date || b.exp_date),
            nafdac_number:   b.nafdac       || b.nafdac_number || b.reg_no     || null,
            cost_price:      utils.parsePrice(b.cost_price || b.unit_cost || "0"),
          })).filter(b => b.quantity > 0);
        }
      }
    }
    return [];
  }


  function handleCapturedDrug(url, payload) {
    const res = payload?.response || {};
    const req = payload?.request  || {};

    const name = (
      req.generic_name  || res.generic_name  ||
      req.brand_name    || res.brand_name    ||
      req.name          || res.name          ||
      req.drug_name     || res.drug_name     ||
      req.product_name  || res.product_name  ||
      req.description   || res.description   ||
      res.drug?.generic_name || res.drug?.name ||
      res.drug?.brand_name   ||
      ""
    ).trim();

    const price = utils.parsePrice(
      req.price            || res.price            ||
      req.selling_price    || res.selling_price    ||
      req.unit_price       || res.unit_price       ||
      res.drug?.price      ||
      req.general_price    || res.general_price    ||
      "0"
    );

    const quantity = parseInt(
      req.quantity || res.quantity ||
      req.qty      || res.qty      ||
      res.drug?.quantity || "0"
    ) || 0;

    if (!name) {
      console.log("MyApoti: Drug capture — name missing, skipping", { req, res });
      return;
    }
    if (!price) {
      console.log("MyApoti: Drug capture — price missing, skipping", { name, req, res });
      return;
    }

    console.log(`MyApoti: Drug add/edit confirmed — ${name}`);

    const batches = extractBatches(payload);

    utils.sendToMyApoti("/extension/sync-inventory", {
      source:     detector.getPlatformName(),
      confidence: 80,
      drugs: [{
        generic_name:    req.generic_name    || res.generic_name    || res.drug?.generic_name || name,
        brand_name:      req.brand_name      || res.brand_name      || res.drug?.brand_name,
        quantity,
        price,
        cost_price:      utils.parsePrice(req.cost_price    || res.cost_price    || req.purchase_price || "0"),
        category:        req.category        || res.category,
        strength:        req.strength        || res.strength        || req.dosage || res.dosage,
        dosage_form:     req.dosage_form     || res.dosage_form     || req.form   || res.form,
        expiration_date: utils.parseDate(req.expiry_date   || res.expiry_date   || req.expiration_date || res.expiration_date),
        nafdac_number:   req.nafdac_number   || res.nafdac_number   || req.barcode || res.barcode || req.sku || res.sku,
        batches,
      }],
    }).then(result => {
      if (!result) return;
      if (result.batch_qty_ignored?.length) {
        console.warn(
          `%cMyApoti%c Quantity update ignored for batch-managed drug(s): ${result.batch_qty_ignored.join(", ")}. ` +
          "To update quantity, use stock receipt with a batch number.",
          "background:#ffc107;color:#333;padding:2px 6px;border-radius:3px",
          "color:#856404"
        );
      }
    });
  }


  function handleCapturedDelete(url, payload) {
    const res = payload?.response || {};
    const req = payload?.request  || {};

    const name = (
      res.generic_name  || res.name || res.drug_name  || res.product_name ||
      req.generic_name  || req.name || req.drug_name  || req.product_name ||
      decodeURIComponent(url.split("/").pop().split("?")[0].replace(/-/g, " ")) ||
      ""
    ).trim();

    if (!name || name.match(/^\d+$/)) {
      console.log("MyApoti: Drug delete confirmed but name unknown — skipping", url);
      return;
    }

    console.log(`MyApoti: Drug delete confirmed — ${name}`);

    utils.sendToMyApoti("/extension/delete-drug", {
      source:     detector.getPlatformName(),
      name,
      deleted_at: new Date().toISOString(),
      raw_url:    url,
    }).then(result => {
      if (result) {
        console.log(
          `%cMyApoti%c Drug deleted — ${result.deleted_name || name}`,
          "background:#dc3545;color:#fff;padding:2px 6px;border-radius:3px",
          "color:#333"
        );
      }
    });
  }


  function handleCapturedBatchUpdate(url, payload) {
    const res = payload?.response || {};
    const req  = payload?.request  || {};

    const batch_number = (
      req.batch_number || req.batch_no || req.lot_number ||
      res.batch_number || res.batch_no ||
      decodeURIComponent(url.split("/").pop().split("?")[0]) ||
      ""
    ).trim().toUpperCase();

    if (!batch_number) {
      console.log("MyApoti: Batch update — batch number unknown, skipping", url);
      return;
    }

    const drug_name = (
      req.drug_name || req.generic_name || req.name ||
      res.drug_name || res.generic_name || res.name || ""
    ).trim();

    const quantity        = parseInt(req.quantity || res.quantity || 0) || null;
    const expiration_date = utils.parseDate(
      req.expiry_date || res.expiry_date || req.expiration_date || res.expiration_date
    );
    const nafdac_number   = req.nafdac_number || res.nafdac_number || null;

    if (!quantity && !expiration_date && !nafdac_number) {
      console.log("MyApoti: Batch update — no fields to update, skipping", { batch_number, drug_name });
      return;
    }

    console.log(`MyApoti: Batch update confirmed — ${batch_number}${drug_name ? " on " + drug_name : ""}`);

    const batchEndpoint = drug_name
      ? `/pharmacies/batches/${encodeURIComponent(batch_number)}?drug_name=${encodeURIComponent(drug_name)}`
      : `/pharmacies/batches/${encodeURIComponent(batch_number)}`;

    utils.sendToMyApoti(batchEndpoint, {
      quantity,
      expiration_date,
      nafdac_number,
    }, "PUT").then(result => {
      if (result) {
        console.log(
          `%cMyApoti%c Batch updated — ${result.batch_number || batch_number}`,
          "background:#007bff;color:#fff;padding:2px 6px;border-radius:3px",
          "color:#333"
        );
      }
    });
  }


  function handleCapturedBatchDelete(url, payload) {
    const res = payload?.response || {};
    const req  = payload?.request  || {};

    const batch_number = (
      req.batch_number || req.batch_no ||
      res.batch_number || res.batch_no ||
      decodeURIComponent(url.split("/").pop().split("?")[0]) ||
      ""
    ).trim().toUpperCase();

    if (!batch_number || batch_number.match(/^\d+$/)) {
      console.log("MyApoti: Batch delete — batch number unknown, skipping", url);
      return;
    }

    const drug_name = (
      req.drug_name || req.generic_name || req.name ||
      res.drug_name || res.generic_name || res.name || ""
    ).trim();

    console.log(`MyApoti: Batch delete confirmed — ${batch_number}${drug_name ? " on " + drug_name : ""}`);

    utils.sendToMyApoti(`/pharmacies/batch/${encodeURIComponent(batch_number)}`, {}, "DELETE").then(result => {
      if (result) {
        console.log(
          `%cMyApoti%c Batch deleted — ${result.batch_number || batch_number}`,
          "background:#dc3545;color:#fff;padding:2px 6px;border-radius:3px",
          "color:#333"
        );
      }
    });
  }


  // ══════════════════════════════════════════════════════
  // PATH 2 — DOM SCRAPING (inventory page fallback)
  // ══════════════════════════════════════════════════════

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
      if (!silent) console.log("MyApoti: No inventory table detected");
      tryCardLayout(silent);
      return;
    }

    const reader = new window.SmartTableReader(bestTable);
    const { drugs, confidence } = reader.readRows();
    if (!drugs.length) return;

    const hasName  = reader.colMap.generic_name !== undefined || reader.colMap.brand_name !== undefined;
    const hasPrice = reader.colMap.price !== undefined;
    if (!hasName || !hasPrice) {
      if (!silent) console.log(
        `MyApoti: Table rejected — missing required fields. ` +
        `hasName=${hasName} hasPrice=${hasPrice} (colMap: ${Object.keys(reader.colMap).join(", ")})`
      );
      return;
    }

    if (!silent) {
      console.log(`MyApoti: Found ${drugs.length} drugs (confidence: ${confidence}%)`);
    }

    const currentHash = utils.hashString(JSON.stringify(drugs));

    chrome.storage.local.get(
      "inventory_hash",
      ({ inventory_hash }) => {
        if (!force && inventory_hash === currentHash) {
          if (!silent) console.log("MyApoti: No changes — skipping");
          return;
        }

        utils.sendToMyApoti("/extension/sync-inventory", {
          source:     detector.getPlatformName(),
          drugs,
          confidence,
        }).then(result => {
          if (result) {
            chrome.storage.local.set({ inventory_hash: currentHash });
            utils.updateStats(result.added || 0, 0);
            console.log(
              `%cMyApoti%c Synced — ${result.added} added, ${result.updated} updated`,
              "background:#28a745;color:#fff;padding:2px 6px;border-radius:3px",
              "color:#333"
            );
          }
        });
      }
    );
  }

  function tryCardLayout(silent = false) {
    const selectors = [
      ".product-card", ".inventory-card", ".drug-card", ".item-card",
      "[class*='product-item']", "[class*='inventory-item']", "[class*='drug-item']",
    ];

    for (const sel of selectors) {
      const cards = document.querySelectorAll(sel);
      if (cards.length >= 3) {
        const drugs = readCardsIntelligently(cards);
        if (drugs.length) {
          if (!silent) console.log(`MyApoti: Found ${drugs.length} drugs in cards`);
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
        "[class*='name']", "[class*='title']", "h3", "h4", "h5", "strong",
        "[class*='product']", "[class*='drug']",
      ]);
      if (!name) return;

      const price = utils.parsePrice(findTextIn(card, [
        "[class*='price']", "[class*='amount']", "[class*='rate']", "[class*='cost']",
      ]));
      if (!price) return;

      const qtyText = findTextIn(card, [
        "[class*='qty']", "[class*='quantity']", "[class*='stock']", "[class*='available']",
      ]);
      const quantity = parseInt((qtyText || "0").replace(/[^0-9]/g, "") || "0");
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
    const currentHash = utils.hashString(JSON.stringify(drugs));
    chrome.storage.local.get("inventory_hash", ({ inventory_hash }) => {
      if (!force && inventory_hash === currentHash) return;
      utils.sendToMyApoti("/extension/sync-inventory", {
        source:     detector.getPlatformName(),
        drugs,
        confidence: 50,
      }).then(result => {
        if (result) {
          chrome.storage.local.set({ inventory_hash: currentHash });
          utils.updateStats(result.added || 0, 0);
        }
      });
    });
  }

  function forceSync() {
    chrome.storage.local.remove("inventory_hash", () => {
      syncInventory(true, false);
    });
  }

})();