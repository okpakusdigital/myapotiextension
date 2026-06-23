// content_scripts/universal.js
(function () {
  "use strict";

  const utils    = window.MyApotiUtils;
  const detector = window.MyApotiDetector;

  window._myapotiDebugInitCount = (window._myapotiDebugInitCount || 0);
  window._myapotiDebugListenerCount = (window._myapotiDebugListenerCount || 0);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    setTimeout(init, 1500);
  }

  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(init, 1500);
    }
  }).observe(document, { subtree: true, childList: true });


  function init() {
    window._myapotiDebugInitCount++;
    console.log(`%c[DEBUG] init() called — count=${window._myapotiDebugInitCount}`, "background:#ff00ff;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold");

    if (!detector.isPharmacyApp()) return;

    const pageType = detector.detectPageType();
    const platform = detector.getPlatformName();

    console.log(
      `%cMyApoti Sync%c Active on ${platform} — ${pageType}`,
      "background:#007bff;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold",
      "color:#333"
    );

    chrome.runtime.sendMessage({
      action: "pharmacy_detected",
      pageType,
      platform,
      url: location.href,
    });

    if (pageType === "inventory") {
      handleInventoryPage();
    }

    chrome.runtime.onMessage.addListener(
      (msg, sender, sendResponse) => {
        if (msg.action === "sync_now") {
          forceSync();
          sendResponse({ success: true });
        }
      }
    );
  }


  async function notifyQueueStatus(result, drugNames = [], eventType = "synced", wasQueued = false) {
    const pending = wasQueued
      ? await utils.getPendingQueueLength()
      : (result?.queue_pending || 0);
    const failed = result?.queue_failed || 0;

    if (!result && !wasQueued) return;

    if (drugNames.length > 0) {
      const syncEntry = {
        drugs:     drugNames.slice(0, 10),
        count:     drugNames.length,
        type:      wasQueued ? "queued" : eventType,
        timestamp: new Date().toISOString(),
        source:    detector.getPlatformName(),
      };

      chrome.storage.local.get("recent_syncs", ({ recent_syncs }) => {
        const syncs = Array.isArray(recent_syncs) ? recent_syncs : [];
        syncs.unshift(syncEntry);
        const trimmed = syncs.slice(0, 10);
        chrome.storage.local.set({
          recent_syncs:  trimmed,
          queue_pending: pending,
          queue_failed:  failed,
        });
      });
    } else {
      chrome.storage.local.set({
        queue_pending: pending,
        queue_failed:  failed,
      });
    }

    chrome.runtime.sendMessage({
      action:        "queue_status_update",
      queue_pending: pending,
      queue_failed:  failed,
      drug_names:    drugNames,
      event_type:    wasQueued ? "queued" : eventType,
    });

    if (pending > 0) {
      console.log(
        `%cMyApoti%c ⏳ ${pending} item(s) pending cloud upload` +
        (failed > 0 ? ` · ❌ ${failed} failed` : ""),
        "background:#3b82f6;color:#fff;padding:2px 6px;border-radius:3px",
        "color:#1d4ed8"
      );
    }
  }


  // ══════════════════════════════════════════════════════
  // PATH 1 — REQUEST INTERCEPTION HANDLER
  // ══════════════════════════════════════════════════════

  window._myapotiDebugListenerCount++;
  console.log(`%c[DEBUG] myapoti_capture listener REGISTERED — total registrations this context=${window._myapotiDebugListenerCount}`, "background:#ff00ff;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold");

  window.addEventListener("myapoti_capture", (e) => {
    const { type, url, method, payload } = e.detail;
    console.log(`%c[DEBUG] myapoti_capture EVENT RECEIVED — type=${type} url=${url}`, "background:#00ffff;color:#000;padding:2px 6px;border-radius:3px;font-weight:bold");

    if (type === "sale") {
      handleCapturedSale(url, payload);
    } else if (type === "stock_receipt") {
      handleCapturedStockReceipt(url, payload);
    } else if (type === "drug") {
      if (payload?.request?.__delete) {
        handleCapturedDelete(url, payload);
      } else {
        handleCapturedDrug(url, payload, method);
      }
    } else if (type === "batch_update") {
      handleCapturedBatchUpdate(url, payload);
    } else if (type === "batch_delete") {
      handleCapturedBatchDelete(url, payload);
    }
  });


  // ── In-memory dedup gate for sales ──
  let _lastSaleHashMemory = null;
  let _lastSaleTimeMemory = 0;
  const SALE_DEDUP_WINDOW_MS = 5000;

  function handleCapturedSale(url, payload) {
    const items = extractSaleItems(payload);
    if (!items.length) return;

    const saleHash = utils.hashString(JSON.stringify(items));
    const now = Date.now();

    const isDuplicate =
      _lastSaleHashMemory === saleHash &&
      (now - _lastSaleTimeMemory) < SALE_DEDUP_WINDOW_MS;

    if (isDuplicate) {
      console.log(`MyApoti: Sale duplicate suppressed (${now - _lastSaleTimeMemory}ms since last)`);
      return;
    }

    _lastSaleHashMemory = saleHash;
    _lastSaleTimeMemory = now;

    chrome.storage.local.set({
      last_sale_hash: saleHash,
      last_sale_time: now,
    });

    console.log(`MyApoti: Sale confirmed by server — ${items.length} items`);

    utils.sendToMyApoti("/extension/sync-sale", {
      source:  detector.getPlatformName(),
      items,
      sold_at: new Date().toISOString(),
      raw_url: url,
    }).then(result => {
      if (result?.__queued) {
        const saleNames = items.map(i => i.name).filter(Boolean);
        notifyQueueStatus(null, saleNames, "sale", true);
        return;
      }
      if (result) {
        utils.updateStats(0, 1);
        console.log(
          `%cMyApoti%c Sale synced — ${result.deducted || 0} items deducted`,
          "background:#28a745;color:#fff;padding:2px 6px;border-radius:3px",
          "color:#333"
        );
        const saleNames = items.map(i => i.name).filter(Boolean);
        notifyQueueStatus(result, saleNames, "sale");
      }
    });
  }


  function extractSaleItems(payload) {
    const sources = [payload?.response, payload?.request];

    for (const source of sources) {
      if (!source) continue;

      const candidates = [
        source?.items, source?.drugs, source?.products,
        source?.line_items, source?.cart, source?.sales_items,
        source?.dispensed_items, source?.data?.items, source?.sale?.items,
        source?.transaction?.items, source?.billing?.items, source?.order?.items,
      ];

      for (const candidate of candidates) {
        if (Array.isArray(candidate) && candidate.length) {
          const mapped = candidate.map(item => ({
            name: (
              item.name || item.drug_name || item.product_name ||
              item.description || item.item_name || item.medicine_name || ""
            ).trim(),
            quantity_sold: parseInt(
              item.quantity || item.qty || item.quantity_sold || item.dispensed_qty || 1
            ),
            unit_price: utils.parsePrice(
              item.price || item.unit_price || item.selling_price ||
              item.amount || item.rate || "0"
            ),
          })).filter(i => i.name && i.quantity_sold > 0);

          if (mapped.length) return mapped;
        }
      }

      const name = (source?.name || source?.drug_name || source?.product_name || "").trim();
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
      if (result?.__queued) {
        const stockNames = items.map(i => i.name).filter(Boolean);
        notifyQueueStatus(null, stockNames, "stock", true);
        return;
      }
      if (result) {
        console.log(`MyApoti: Stock receipt synced — ${result.updated || 0} updated`);
        const stockNames = items.map(i => i.name).filter(Boolean);
        notifyQueueStatus(result, stockNames, "stock");
      }
    });
  }


  function extractStockItems(payload) {
    const sources = [payload?.response, payload?.request];

    for (const source of sources) {
      if (!source) continue;

      const candidates = [
        source?.items, source?.drugs, source?.products,
        source?.received_items, source?.stock_items, source?.data?.items,
      ];

      for (const candidate of candidates) {
        if (Array.isArray(candidate) && candidate.length) {
          return candidate.map(item => ({
            name: (
              item.name || item.drug_name || item.product_name || item.description || ""
            ).trim(),
            quantity_received: parseInt(
              item.quantity || item.qty || item.quantity_received || item.received_qty || 0
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
        source?.batches, source?.batch_items, source?.stock_batches,
        source?.drug?.batches, source?.data?.batches,
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


  function handleCapturedDrug(url, payload, method) {
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
      res.drug?.brand_name   || ""
    ).trim();

    if (!name) {
      console.log("MyApoti: Drug capture — name missing, skipping", { url, req, res });
      return;
    }

    const isPut = method === "PUT" || method === "PATCH";

    // ── Price: extract whatever value the HMIS sent, may be 0 ──
    // For PUT/PATCH: price:0 means unchanged — backend leaves existing price alone.
    // For POST: price:0 is allowed if cost_price is present — backend will create
    //   the record with ₦0 selling price as a placeholder.
    //   If both price and cost_price are 0, skip — nothing useful to store.
    const price = utils.parsePrice(
      req.price         || res.price         ||
      req.selling_price || res.selling_price ||
      req.unit_price    || res.unit_price    ||
      res.drug?.price   ||
      req.general_price || res.general_price || "0"
    );

    const cost_price = utils.parsePrice(
      req.cost_price || res.cost_price || req.purchase_price || "0"
    );

    if (!isPut && !price && !cost_price) {
      console.log("MyApoti: Drug capture — no price or cost price on new drug (POST), skipping", { name, req, res });
      return;
    }

    const quantity = parseInt(
      req.quantity || res.quantity ||
      req.qty      || res.qty      ||
      res.drug?.quantity || "0"
    ) || 0;

    console.log(`MyApoti: Drug add/edit confirmed — ${name} (method: ${method})`);

    const batches = extractBatches(payload);

    // ── Build the drug payload with only truthy/non-zero fields.
    // For PUT/PATCH this is a partial update — only fields the HMIS
    // actually provided should reach the backend. Fields that are
    // zero/empty/null are omitted entirely so the backend leaves the
    // existing DB value untouched.
    // For POST (new drug) all available fields are included.
    const drugPayload = {
      generic_name: req.generic_name || res.generic_name || res.drug?.generic_name || name,
      batches,
    };

    // brand_name — include only if non-empty
    const brand_name = (req.brand_name || res.brand_name || res.drug?.brand_name || "").trim();
    if (brand_name) drugPayload.brand_name = brand_name;

    // quantity — include only if > 0
    if (quantity > 0) drugPayload.quantity = quantity;

    // price — include only if > 0 (PUT with price:0 means "unchanged")
    if (price && price > 0) drugPayload.price = price;

    // cost_price — include only if > 0
    if (cost_price && cost_price > 0) drugPayload.cost_price = cost_price;

    // category — include only if non-empty
    const category = (req.category || res.category || "").trim();
    if (category) drugPayload.category = category;

    // strength — include only if non-empty
    const strength = (req.strength || res.strength || req.dosage || res.dosage || "").trim();
    if (strength) drugPayload.strength = strength;

    // dosage_form — include only if non-empty
    const dosage_form = (req.dosage_form || res.dosage_form || req.form || res.form || "").trim();
    if (dosage_form) drugPayload.dosage_form = dosage_form;

    // expiration_date — include only if parseable
    const expiration_date = utils.parseDate(
      req.expiry_date || res.expiry_date || req.expiration_date || res.expiration_date
    );
    if (expiration_date) drugPayload.expiration_date = expiration_date;

    // nafdac_number — include only if non-empty
    const nafdac_number = (
      req.nafdac_number || res.nafdac_number ||
      req.barcode || res.barcode ||
      req.sku || res.sku || ""
    ).trim();
    if (nafdac_number) drugPayload.nafdac_number = nafdac_number;

    utils.sendToMyApoti("/extension/sync-inventory", {
      source:     detector.getPlatformName(),
      confidence: 80,
      method:     method,   // "POST", "PUT", or "PATCH" — backend derives behavior
      drugs:      [drugPayload],
    }).then(result => {
      if (result?.__queued) {
        notifyQueueStatus(null, [name], "queued", true);
        return;
      }
      if (!result) return;

      // ── Drug already exists — POST tried to overwrite an existing record ──
      if (result.already_exists > 0) {
        console.warn(
          `%cMyApoti%c "${name}" already exists in MyApoti. ` +
          "Use the HMIS edit function (not add) to update it.",
          "background:#856404;color:#fff;padding:2px 6px;border-radius:3px",
          "color:#856404"
        );
        notifyQueueStatus({ queue_pending: result.queue_pending, queue_failed: result.queue_failed }, [name], "not_found");
        return;
      }

      // ── Drug not found for a PUT/PATCH ──
      if (result.not_found > 0) {
        console.warn(
          `%cMyApoti%c Cannot update "${name}" — not found in MyApoti. ` +
          "This drug must be added to MyApoti's inventory before it can be edited via the extension.",
          "background:#dc3545;color:#fff;padding:2px 6px;border-radius:3px",
          "color:#721c24"
        );
        notifyQueueStatus({ queue_pending: result.queue_pending, queue_failed: result.queue_failed }, [name], "not_found");
        return;
      }

      if (result.batch_qty_ignored?.length) {
        console.warn(
          `%cMyApoti%c Quantity update ignored for batch-managed drug(s): ${result.batch_qty_ignored.join(", ")}. ` +
          "To update quantity, use stock receipt with a batch number.",
          "background:#ffc107;color:#333;padding:2px 6px;border-radius:3px",
          "color:#856404"
        );
      }

      const eventType = result.added > 0 ? "added" : "updated";
      notifyQueueStatus(result, [name], eventType);
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
      if (result?.__queued) {
        notifyQueueStatus(null, [name], "queued", true);
        return;
      }
      if (result) {
        console.log(
          `%cMyApoti%c Drug deleted — ${result.deleted_name || name}`,
          "background:#dc3545;color:#fff;padding:2px 6px;border-radius:3px",
          "color:#333"
        );
        notifyQueueStatus(result, [result.deleted_name || name], "deleted");
      }
    });
  }


  function handleCapturedBatchUpdate(url, payload) {
    const res = payload?.response || {};
    const req = payload?.request  || {};

    const batch_number = (
      req.batch_number || req.batch_no || req.lot_number ||
      res.batch_number || res.batch_no ||
      decodeURIComponent(url.split("/").pop().split("?")[0]) || ""
    ).trim().toUpperCase();

    if (!batch_number) {
      console.log("MyApoti: Batch update — batch number unknown, skipping", url);
      return;
    }

    const drug_name       = (req.drug_name || req.generic_name || req.name || res.drug_name || res.generic_name || res.name || "").trim();
    const quantity        = parseInt(req.quantity || res.quantity || 0) || null;
    const expiration_date = utils.parseDate(req.expiry_date || res.expiry_date || req.expiration_date || res.expiration_date);
    const nafdac_number   = req.nafdac_number || res.nafdac_number || null;

    if (!quantity && !expiration_date && !nafdac_number) {
      console.log("MyApoti: Batch update — no fields to update, skipping", { batch_number, drug_name });
      return;
    }

    console.log(`MyApoti: Batch update confirmed — ${batch_number}${drug_name ? " on " + drug_name : ""}`);

    const batchEndpoint = drug_name
      ? `/pharmacies/batches/${encodeURIComponent(batch_number)}?drug_name=${encodeURIComponent(drug_name)}`
      : `/pharmacies/batches/${encodeURIComponent(batch_number)}`;

    utils.sendToMyApoti(batchEndpoint, { quantity, expiration_date, nafdac_number }, "PUT").then(result => {
      if (result?.__queued) {
        notifyQueueStatus(null, [drug_name || batch_number], "queued", true);
        return;
      }
      if (result) {
        console.log(
          `%cMyApoti%c Batch updated — ${result.batch_number || batch_number}`,
          "background:#007bff;color:#fff;padding:2px 6px;border-radius:3px",
          "color:#333"
        );
        notifyQueueStatus(result, [drug_name || batch_number], "updated");
      }
    });
  }


  function handleCapturedBatchDelete(url, payload) {
    const res = payload?.response || {};
    const req = payload?.request  || {};

    const batch_number = (
      req.batch_number || req.batch_no ||
      res.batch_number || res.batch_no ||
      decodeURIComponent(url.split("/").pop().split("?")[0]) || ""
    ).trim().toUpperCase();

    if (!batch_number || batch_number.match(/^\d+$/)) {
      console.log("MyApoti: Batch delete — batch number unknown, skipping", url);
      return;
    }

    const drug_name = (req.drug_name || req.generic_name || req.name || res.drug_name || res.generic_name || res.name || "").trim();

    console.log(`MyApoti: Batch delete confirmed — ${batch_number}${drug_name ? " on " + drug_name : ""}`);

    utils.sendToMyApoti(`/pharmacies/batch/${encodeURIComponent(batch_number)}`, {}, "DELETE").then(result => {
      if (result?.__queued) {
        notifyQueueStatus(null, [drug_name || batch_number], "queued", true);
        return;
      }
      if (result) {
        console.log(
          `%cMyApoti%c Batch deleted — ${result.batch_number || batch_number}`,
          "background:#dc3545;color:#fff;padding:2px 6px;border-radius:3px",
          "color:#333"
        );
        notifyQueueStatus(result, [drug_name || batch_number], "deleted");
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

    const debouncedSync = utils.debounce(() => syncInventory(false, true), 2000);
    new MutationObserver(debouncedSync).observe(document.body, { childList: true, subtree: true });
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
      if (reader.isInventoryTable() && reader.confidence > bestConfidence) {
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
      if (!silent) console.log(`MyApoti: Table rejected — missing required fields. hasName=${hasName} hasPrice=${hasPrice}`);
      return;
    }

    if (!silent) console.log(`MyApoti: Found ${drugs.length} drugs (confidence: ${confidence}%)`);

    const currentHash = utils.hashString(JSON.stringify(drugs));

    chrome.storage.local.get("inventory_hash", ({ inventory_hash }) => {
      if (!force && inventory_hash === currentHash) {
        if (!silent) console.log("MyApoti: No changes — skipping");
        return;
      }

      // ── DOM scrape: no method sent → backend treats as scrape (is_scrape=true)
      // Scrape is allowed to update existing records — it always sees the full
      // current inventory table and must keep prices/quantities in sync.
      utils.sendToMyApoti("/extension/sync-inventory", {
        source:     detector.getPlatformName(),
        drugs,
        confidence,
        // method intentionally omitted — scrape has no HTTP method context
      }).then(result => {
        if (result?.__queued) {
          const drugNames = drugs.map(d => d.generic_name || d.brand_name).filter(Boolean);
          notifyQueueStatus(null, drugNames, "queued", true);
          return;
        }
        if (result) {
          chrome.storage.local.set({ inventory_hash: currentHash });
          utils.updateStats(result.added || 0, 0);
          console.log(
            `%cMyApoti%c Synced — ${result.added} added, ${result.updated} updated`,
            "background:#28a745;color:#fff;padding:2px 6px;border-radius:3px",
            "color:#333"
          );
          const drugNames = drugs.map(d => d.generic_name || d.brand_name).filter(Boolean);
          const eventType = result.added > 0 ? "added" : "updated";
          notifyQueueStatus(result, drugNames, eventType);
        }
      });
    });
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

      const qtyText  = findTextIn(card, ["[class*='qty']", "[class*='quantity']", "[class*='stock']", "[class*='available']"]);
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
        // method intentionally omitted — card scrape has no HTTP method context
      }).then(result => {
        if (result?.__queued) {
          const drugNames = drugs.map(d => d.generic_name || d.brand_name).filter(Boolean);
          notifyQueueStatus(null, drugNames, "queued", true);
          return;
        }
        if (result) {
          chrome.storage.local.set({ inventory_hash: currentHash });
          utils.updateStats(result.added || 0, 0);
          const drugNames = drugs.map(d => d.generic_name || d.brand_name).filter(Boolean);
          const eventType = result.added > 0 ? "added" : "updated";
          notifyQueueStatus(result, drugNames, eventType);
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