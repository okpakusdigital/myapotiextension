// ─────────────────────────────────────────────────────────────────────────────
// MyApoti Universal HMIS Connector — content.js
// Injected into every browser tab via manifest.json content_scripts.
// Scans HTML tables on page load using the Smart Reader logic,
// detects inventory/drug register pages, and pushes drugs to MyApoti.
// Works alongside existing request interception in the background script.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  "use strict";

  // ── Constants ──────────────────────────────────────────────────────────────
  const MYAPOTI_API        = "http://127.0.0.1:8000";
  const SCAN_DELAY_MS      = 1500;
  const MIN_DRUG_ROWS      = 3;
  const MIN_CONFIDENCE     = 25;
  const STORAGE_KEY_PREFIX = "myapoti_synced_";

  // ── Field patterns (mirrored from App.jsx SmartReader) ────────────────────
  const FIELD_PATTERNS = {
    generic_name: { headers: ["generic name","generic","inn","active ingredient","description","drug description","item description","product description","drug name","medicine name","item name","name","product name","drug","medicine","medication","item"], weight: 10 },
    brand_name:   { headers: ["brand name","brand","trade name","proprietary name","product brand","commercial name","trademark"], weight: 8 },
    quantity:     { headers: ["quantity","qty","stock","in stock","available","balance","on hand","current stock","closing stock","units","q","qnty"], weight: 10 },
    price:        { headers: ["selling price","sale price","retail price","unit price","retail","sell price","general price","gp","g.p","customer price","dispensing price","price","amount","rate","nsp","sp"], weight: 10 },
    cost_price:   { headers: ["cost price","cost","purchase price","buy price","buying price","landed cost","unit cost","supplier price","cp","c.p","p.price"], weight: 8 },
    expiry_date:  { headers: ["expiry date","expiration date","expiry","best before","use by","exp date","exp","expire","expiration","shelf life","valid till","exp. date"], weight: 7 },
    category:     { headers: ["category","group","type","class","drug class","classification","therapeutic class"], weight: 5 },
    strength:     { headers: ["strength","dosage","concentration","dose","potency","strength/dose","conc"], weight: 5 },
    dosage_form:  { headers: ["dosage form","form","formulation","drug form","presentation","unit of issue","unit","units","uoi"], weight: 4 },
    barcode:      { headers: ["nafdac","nafdac no","nafdac number","reg no","registration number","barcode","sku","code","product code","lot number","batch number","batch no"], weight: 5 },
    manufacturer: { headers: ["manufacturer","supplier","vendor","made by","company","manufactured by","mfr","mfg"], weight: 4 },
    pack_size:    { headers: ["pack size","packing","unit of measure","uom","packs per unit","pack"], weight: 3 },
  };

  const PRICE_SELLING_CLUES = ["sell","retail","sale","general","gp","customer","dispens","patient","sp","nsp"];
  const PRICE_COST_CLUES    = ["cost","purchase","buy","buying","wholesale","vendor","supplier","cp","procure","landed"];
  const DOSAGE_FORMS        = ["tablet","capsule","syrup","injection","cream","ointment","gel","drops","inhaler","sachet","suspension","solution","powder","lotion","patch","suppository","spray"];

  // ── Utility helpers ────────────────────────────────────────────────────────
  function parsePrice(text) {
    if (!text) return null;
    const cleaned = String(text).replace(/[₦,\s]/g, "").replace(/[^0-9.]/g, "").trim();
    const num = parseFloat(cleaned);
    return isNaN(num) || num <= 0 ? null : num;
  }

  function parseDate(text) {
    if (!text) return null;
    const s = String(text).trim();
    let m;
    m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return s;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
    return null;
  }

  function normalizeCell(text) {
    return (text || "")
      .replace(/^\s*\d+[\.\)]\s*/, "")
      .replace(/^[-•·]\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // ── Smart reader (column detection + drug extraction) ─────────────────────
  function readSmartTable(headers, rows) {
    const hdrs = headers.map((h, idx) => ({
      text: h.trim().toLowerCase().replace(/\s+/g, " "),
      idx,
    }));

    const colMap = {};
    let totalScore = 0;
    const maxScore = Object.values(FIELD_PATTERNS).reduce((s, c) => s + c.weight, 0);

    for (const [field, config] of Object.entries(FIELD_PATTERNS)) {
      let bestIdx = -1, bestScore = 0;
      for (const hdr of hdrs) {
        for (const pattern of config.headers) {
          let score = 0;
          if (hdr.text === pattern) score = config.weight;
          else if (hdr.text.includes(pattern) || pattern.includes(hdr.text)) score = config.weight * 0.7;
          if (score > bestScore) { bestScore = score; bestIdx = hdr.idx; }
        }
      }
      if (bestIdx >= 0) { colMap[field] = bestIdx; totalScore += bestScore; }
    }

    if (colMap.generic_name !== undefined && colMap.brand_name !== undefined &&
        colMap.generic_name === colMap.brand_name) {
      const brandPatterns = FIELD_PATTERNS.brand_name.headers;
      let brandBest = -1, brandScore = 0;
      for (const hdr of hdrs) {
        if (hdr.idx === colMap.generic_name) continue;
        for (const pattern of brandPatterns) {
          let score = 0;
          if (hdr.text === pattern) score = FIELD_PATTERNS.brand_name.weight;
          else if (hdr.text.includes(pattern) || pattern.includes(hdr.text)) score = FIELD_PATTERNS.brand_name.weight * 0.7;
          if (score > brandScore) { brandScore = score; brandBest = hdr.idx; }
        }
      }
      if (brandBest >= 0) colMap.brand_name = brandBest;
      else delete colMap.brand_name;
    }

    const priceHdrs = hdrs.filter(h => PRICE_SELLING_CLUES.some(c => h.text.includes(c)));
    const costHdrs  = hdrs.filter(h => PRICE_COST_CLUES.some(c => h.text.includes(c)));
    if (priceHdrs.length > 0 && costHdrs.length > 0) {
      colMap.price      = priceHdrs[0].idx;
      colMap.cost_price = costHdrs[0].idx;
    } else {
      const pricePatterns = FIELD_PATTERNS.price.headers;
      const allPriceCols = hdrs.filter(h =>
        pricePatterns.some(p => h.text === p || h.text.includes(p) || p.includes(h.text))
      );
      if (allPriceCols.length >= 2 && colMap.cost_price === undefined) {
        const withAvg = allPriceCols.map(h => {
          const vals = rows.map(r => parseFloat((r[h.idx] || "").replace(/[₦,\s]/g,"")) || 0).filter(v => v > 0);
          return { idx: h.idx, avg: vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : 0 };
        }).sort((a,b) => b.avg - a.avg);
        colMap.price      = withAvg[0].idx;
        colMap.cost_price = withAvg[1].idx;
      }
    }

    const drugNameScore = (text) => {
      if (!text) return 0;
      const t = text.toLowerCase().trim();
      const hasVerb = /(used for|indicated for|treatment of|helps|prescribed|relieves|reduces|prevents|belongs to|acts as|works by)/i.test(t);
      if (hasVerb) return 0;
      const wordCount = t.split(/\s+/).length;
      if (wordCount > 7) return 0;
      const hasDosage = /\d+\s*(mg|mcg|ml|g|iu|%)/i.test(t);
      const hasForm   = DOSAGE_FORMS.some(f => t.includes(f));
      if (hasDosage && hasForm) return 1.0;
      if (hasDosage) return 0.9;
      if (hasForm)   return 0.8;
      if (t.length <= 4) return 0.2;
      if (wordCount <= 3) return 0.5;
      return 0.4;
    };

    const scoreColAsDrugName = (colIdx) => {
      const sample = rows.slice(0, 5);
      if (!sample.length) return 0;
      const scores = sample.map(r => drugNameScore(r[colIdx] || ""));
      return scores.reduce((a,b) => a+b, 0) / sample.length;
    };

    const descHdr = hdrs.find(h => h.text === "description" || h.text.includes("description") || h.text === "item");
    const nameHdr = hdrs.find(h => ["name","drug name","item name","medicine"].includes(h.text));

    if (colMap.generic_name === undefined && descHdr) {
      if (scoreColAsDrugName(descHdr.idx) >= 0.4) colMap.generic_name = descHdr.idx;
    } else if (descHdr && nameHdr && colMap.generic_name !== undefined) {
      const ds = scoreColAsDrugName(descHdr.idx);
      const ns = scoreColAsDrugName(nameHdr.idx);
      if (ds > ns + 0.3) colMap.generic_name = descHdr.idx;
    }

    if (colMap.dosage_form === undefined) {
      for (let i = 0; i < headers.length; i++) {
        const matches = rows.slice(0, 5).filter(r => {
          const v = (r[i] || "").trim().toLowerCase();
          return DOSAGE_FORMS.some(f => v === f || v.startsWith(f));
        });
        if (matches.length >= 2) { colMap.dosage_form = i; break; }
      }
    }

    const confidence = Math.round((totalScore / maxScore) * 100);

    const drugs = rows.filter(r => r.some(c => c.trim())).map(row => {
      const getCell = (field) => {
        const idx = colMap[field];
        return idx !== undefined && idx < row.length ? normalizeCell(row[idx] || "") : null;
      };
      const name = getCell("generic_name") || getCell("brand_name");
      if (!name) return null;
      const price = parsePrice(getCell("price"));
      if (!price || price <= 0) return null;
      const qty = parseInt((getCell("quantity") || "0").replace(/[^0-9]/g, "")) || 0;
      let cost_price = parsePrice(getCell("cost_price"));
      if (cost_price && cost_price > price * 2) cost_price = null;
      const formRaw = getCell("dosage_form");
      const dosage_form = formRaw && DOSAGE_FORMS.some(f => formRaw.toLowerCase().includes(f)) ? formRaw : null;
      const strRaw = getCell("strength");
      const strength = strRaw && /\d/.test(strRaw) ? strRaw : null;
      return {
        generic_name:     name,
        brand_name:       getCell("brand_name"),
        quantity:         qty,
        price,
        cost_price,
        strength,
        dosage_form,
        expiration_date:  parseDate(getCell("expiry_date")),
        nafdac_number:    getCell("barcode"),
        manufacturer:     getCell("manufacturer"),
      };
    }).filter(Boolean);

    return { colMap, confidence, drugs };
  }

  // ── DOM table extractor ────────────────────────────────────────────────────
  function extractTable(table) {
    const rows = Array.from(table.querySelectorAll("tr"));
    if (rows.length < 2) return null;

    let headerRow = rows.find(r => r.querySelectorAll("th").length > 0) || rows[0];
    const headerCells = Array.from(
      headerRow.querySelectorAll("th, td")
    ).map(cell => {
      const input = cell.querySelector("input");
      if (input && input.value && input.value.trim()) return input.value.trim();
      return (cell.innerText || cell.textContent || "").replace(/\s+/g, " ").trim();
    });

    if (headerCells.length < 2) return null;

    const headerRowIndex = rows.indexOf(headerRow);
    const dataRows = rows.slice(headerRowIndex + 1).map(row =>
      Array.from(row.querySelectorAll("td")).map(cell => {
        const input = cell.querySelector("input");
        if (input && input.value && input.value.trim()) return input.value.trim();
        return (cell.innerText || cell.textContent || "").trim();
      })
    ).filter(row => row.length > 0 && row.some(c => c.length > 0));

    if (dataRows.length < MIN_DRUG_ROWS) return null;

    return { headers: headerCells, rows: dataRows };
  }

  // ── Get auth token from chrome.storage ────────────────────────────────────
  async function getToken() {
    return new Promise((resolve) => {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(["myapoti_token", "access_token"], (result) => {
          resolve(result.myapoti_token || result.access_token || null);
        });
      } else {
        resolve(null);
      }
    });
  }

  // ── Send drugs to MyApoti backend ─────────────────────────────────────────
  async function sendDrugsToMyApoti(drugs, confidence) {
    const token = await getToken();
    if (!token) {
      console.warn("[MyApoti] No auth token found — not syncing");
      return { success: false, reason: "no_token" };
    }

    const utils = window.MyApotiUtils;
    if (!utils) {
      console.warn("[MyApoti] utils.js not loaded — cannot sync");
      return { success: false, reason: "utils_missing" };
    }

    const result = await utils.sendToMyApoti("/extension/sync-inventory", {
      source:     "hmis_scrape",
      confidence: confidence ?? 50,
      // method intentionally omitted — absence signals scrape to backend
      drugs: drugs.map(drug => ({
        generic_name:    drug.generic_name,
        brand_name:      drug.brand_name      || null,
        quantity:        drug.quantity         || 0,
        price:           drug.price,
        cost_price:      drug.cost_price       || null,
        strength:        drug.strength         || null,
        dosage_form:     drug.dosage_form      || null,
        expiration_date: drug.expiration_date  || null,
        nafdac_number:   drug.nafdac_number    || null,
        manufacturer:    drug.manufacturer     || null,
      })),
    });

    if (result?.__queued) {
      return { success: true, synced: 0, failed: 0, queued: true,
               skipped: 0, already_exists: 0 };
    }

    if (result) {
      // ── Read the actual breakdown from the backend response.
      // Previously this always reported `drugs.length` as synced regardless
      // of what the backend actually did — masking already_exists conflicts
      // and making the log misleading ("Synced 8 drugs" when all 8 were
      // skipped because they already existed).
      const synced        = (result.added   || 0) + (result.updated || 0);
      const skipped       = result.skipped  || 0;
      const already       = result.already_exists || 0;
      const failed        = result.failed   || 0;
      return {
        success:        true,
        synced,
        failed,
        queued:         false,
        skipped,
        already_exists: already,
      };
    }

    return { success: false, synced: 0, failed: drugs.length,
             reason: "send_failed" };
  }

  // ── Deduplication — skip pages already synced this session ────────────────
  function getPageKey() {
    return `${location.hostname}${location.pathname}`;
  }

  function alreadySyncedThisSession() {
    try {
      return sessionStorage.getItem(STORAGE_KEY_PREFIX + getPageKey()) === "1";
    } catch (e) {
      return false;
    }
  }

  function markSyncedThisSession() {
    try {
      sessionStorage.setItem(STORAGE_KEY_PREFIX + getPageKey(), "1");
    } catch (e) {}
  }

  // ── Notify popup/background of sync result ────────────────────────────────
  function notifyBackground(type, data) {
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type, ...data });
      }
    } catch (e) {}
  }

  // ── Main scan logic ────────────────────────────────────────────────────────
  async function scanAndSync() {
    if (alreadySyncedThisSession()) {
      console.log("[MyApoti] Already synced this page this session — skipping");
      return;
    }

    const tables = Array.from(document.querySelectorAll("table"));
    if (tables.length === 0) return;

    console.log(`[MyApoti] Scanning ${tables.length} table(s) on ${location.href}`);

    let bestResult = null;
    let bestScore  = 0;

    for (const table of tables) {
      const extracted = extractTable(table);
      if (!extracted) continue;

      const result = readSmartTable(extracted.headers, extracted.rows);
      console.log(`[MyApoti] Table headers:`, extracted.headers,
        `confidence: ${result.confidence}% drugs: ${result.drugs.length}`);

      if (result.confidence > bestScore && result.drugs.length >= MIN_DRUG_ROWS) {
        bestScore  = result.confidence;
        bestResult = result;
      }
    }

    if (!bestResult || bestScore < MIN_CONFIDENCE) {
      console.log(`[MyApoti] No inventory table detected (best confidence: ${bestScore}%)`);
      return;
    }

    const { drugs, confidence } = bestResult;
    console.log(`[MyApoti] Found ${drugs.length} drugs (confidence: ${confidence}%) — syncing...`);

    notifyBackground("myapoti_scrape_started", {
      url:        location.href,
      drug_count: drugs.length,
      confidence,
    });

    const result = await sendDrugsToMyApoti(drugs, confidence);

    if (result.success) {
      if (!result.queued) {
        markSyncedThisSession();
      } else {
        console.log("[MyApoti] Sync queued until desktop app is ready — page NOT marked synced");
      }

      // ── Accurate breakdown log ──
      // Previously always showed "Synced N drugs" regardless of what the
      // backend actually did. Now shows a truthful breakdown so it's clear
      // when drugs were skipped because they already exist vs genuinely synced.
      const parts = [];
      if (result.synced        > 0) parts.push(`${result.synced} synced`);
      if (result.already_exists > 0) parts.push(`${result.already_exists} already exist (skipped)`);
      if (result.skipped       > 0) parts.push(`${result.skipped} skipped`);
      if (result.failed        > 0) parts.push(`${result.failed} failed`);
      if (result.queued)             parts.push("queued");
      console.log(`[MyApoti] ✅ ${parts.join(", ") || "nothing to sync"}`);

      notifyBackground("myapoti_scrape_complete", {
        url:           location.href,
        synced:        result.synced,
        already_exists: result.already_exists,
        skipped:       result.skipped,
        failed:        result.failed,
        queued:        result.queued || false,
      });
    } else {
      console.warn(`[MyApoti] Sync skipped: ${result.reason}`);
      notifyBackground("myapoti_scrape_skipped", {
        url:    location.href,
        reason: result.reason,
      });
    }
  }

  // ── Entry point — wait for page to settle, then scan ──────────────────────
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      setTimeout(scanAndSync, SCAN_DELAY_MS);
    });
  } else {
    setTimeout(scanAndSync, SCAN_DELAY_MS);
  }

  // ── SPA support — rescan on URL changes OR new tables appearing ──────────
  let lastUrl        = location.href;
  let lastTableCount = document.querySelectorAll("table").length;
  let rescanTimer    = null;

  const spaObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl        = location.href;
      lastTableCount = 0;
      console.log("[MyApoti] URL changed — rescanning");
      clearTimeout(rescanTimer);
      rescanTimer = setTimeout(() => {
        try { sessionStorage.removeItem(STORAGE_KEY_PREFIX + getPageKey()); } catch(e) {}
        scanAndSync();
      }, SCAN_DELAY_MS);
      return;
    }

    const currentTableCount = document.querySelectorAll("table").length;
    if (currentTableCount !== lastTableCount) {
      lastTableCount = currentTableCount;
      clearTimeout(rescanTimer);
      rescanTimer = setTimeout(() => {
        console.log("[MyApoti] New table detected — rescanning");
        try { sessionStorage.removeItem(STORAGE_KEY_PREFIX + getPageKey()); } catch(e) {}
        scanAndSync();
      }, SCAN_DELAY_MS);
    }
  });

  spaObserver.observe(document.body || document.documentElement, {
    subtree:   true,
    childList: true,
  });

})();