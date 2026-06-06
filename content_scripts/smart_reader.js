// smart_reader.js
// Intelligently reads any pharmacy table or form
// Maps columns to MyApoti fields automatically

window.SmartTableReader = class SmartTableReader {

  // ─────────────────────────────────────────────────────────────
  // FIELD PATTERNS
  // Each field lists every possible column header name seen across
  // Nigerian HMIS systems (Dulos, VirtualRx, DrugStoc, mPharma,
  // custom Excel exports, etc).
  //
  // Rules:
  //   - All headers lowercased — comparison is case-insensitive
  //   - Partial matches score 70% of full match weight
  //   - weight = how important this field is for confidence scoring
  //   - price vs cost_price: disambiguated by header AND value analysis
  // ─────────────────────────────────────────────────────────────
  static FIELD_PATTERNS = {

    generic_name: {
      headers: [
        // Standard
        "generic name", "generic", "inn", "active ingredient",
        "non-proprietary name",
        // "Description" is the most common alias in Nigerian HMIS —
        // Dulos, VirtualRx, and most custom systems use this
        "description", "drug description", "item description",
        "product description", "article description",
        // "Name" variants
        "drug name", "medicine name", "medication name",
        "item name", "name", "product name",
        // Abbreviated
        "drug", "medicine", "medication", "item", "article",
        // Some systems prefix with numbers or bullets — handled by
        // cell text normalization below
        "s/n", "s.no", "sno",   // sometimes first col has drug name
      ],
      weight: 10,
    },

    brand_name: {
      headers: [
        "brand name", "brand", "trade name", "proprietary name",
        "product brand", "commercial name", "trade mark",
        "trademark", "branded name",
      ],
      weight: 8,
    },

    quantity: {
      headers: [
        "quantity", "qty", "stock", "in stock", "available",
        "balance", "on hand", "current stock", "stock level",
        "stock qty", "quantity available", "quantity on hand",
        "closing stock", "opening stock", "stock balance",
        "units", "no of units", "number of units",
        "available qty", "current qty", "total qty",
        "total stock", "stock count", "count",
        // Abbreviated columns in narrow tables
        "q", "qnty",
      ],
      weight: 10,
    },

    price: {
      // Selling price — what the customer pays
      // Disambiguated from cost_price by header keywords and value
      headers: [
        // Explicit selling price headers
        "selling price", "sale price", "retail price",
        "unit price", "retail", "sell price", "sold at",
        // "General price" is the most common in Nigerian HMIS
        "general price", "gp", "g.p",
        // Others
        "customer price", "dispensing price", "patient price",
        "dispensed price", "issue price", "selling", "issued at",
        "price", "amount", "rate", "unit rate",
        // Vague headers that are likely selling price when only one
        // price column exists (resolved by value disambiguation)
        "nsp", "sp",
      ],
      weight: 10,
    },

    cost_price: {
      // Purchase price — what the pharmacy paid
      headers: [
        "cost price", "cost", "purchase price", "buy price",
        "buying price", "landed cost", "unit cost",
        "unit cost price", "supplier price", "vendor price",
        "procurement price", "acquisition cost",
        "wholesale price", "ex-factory", "cp", "c.p",
        "p.price", "pur price", "purc price",
      ],
      weight: 8,
    },

    expiry_date: {
      headers: [
        "expiry date", "expiration date", "expiry",
        "best before", "use by", "exp date", "exp",
        "expire", "expiration", "expiry/best before",
        "shelf life", "valid till", "valid until",
        "validity", "exp. date",
      ],
      weight: 7,
    },

    category: {
      headers: [
        "category", "group", "type", "class",
        "drug class", "classification", "department",
        "product group", "therapeutic class",
        "drug formulation", "drug classification",
        "therapeutic group", "atc", "atc class",
        "drug category", "formulary class",
      ],
      weight: 5,
    },

    strength: {
      headers: [
        "strength", "dosage", "concentration",
        "dose", "potency", "strength/dose",
        "dose strength", "drug strength", "conc",
        // Some tables embed strength in a combined column
        "strength/form", "dose/form",
      ],
      weight: 5,
    },

    dosage_form: {
      headers: [
        "dosage form", "form", "formulation",
        "drug form", "presentation", "dosage forms",
        "product form", "unit of issue",
        // "Unit of issue" is very common in Nigerian HMIS
        // and usually means the dosage form (Tablet, Capsule, etc)
        "unit", "units",
      ],
      weight: 4,
    },

    barcode: {
      // Maps to nafdac_number in MyApoti
      headers: [
        "nafdac", "nafdac no", "nafdac number", "nafdac reg",
        "nafdac registration", "reg no", "registration number",
        "reg. no", "registration no", "item code", "stock code",
        "barcode", "sku", "code", "product code",
        "lot number", "lot no", "batch number", "batch no",
        "serial", "serial number",
      ],
      weight: 5,
    },

    manufacturer: {
      headers: [
        "manufacturer", "supplier", "vendor",
        "made by", "brand company", "company",
        "manufactured by", "mfr", "mfr.", "mfg",
        "origin", "source", "produced by", "maker",
      ],
      weight: 4,
    },

    pack_size: {
      headers: [
        "pack size", "packing", "unit of issue",
        "unit of measure", "uom", "packs per unit",
        "pack qty", "pack", "per pack",
      ],
      weight: 3,
    },
  };

  // ─────────────────────────────────────────────────────────────
  // Value-based clues for when headers are ambiguous.
  // Used to disambiguate price vs cost_price when headers don't
  // clearly indicate which is which.
  // ─────────────────────────────────────────────────────────────
  static PRICE_SELLING_CLUES  = ["sell", "retail", "sale", "general", "gp", "customer", "dispens", "patient", "sp", "nsp"]; // "issue" removed — "unit of issue" is dosage form, not price
  static PRICE_COST_CLUES     = ["cost", "purchase", "buy", "buying", "wholesale", "vendor", "supplier", "cp", "procure", "landed", "acqui"];
  static DOSAGE_FORM_VALUES   = ["tablet", "capsule", "syrup", "injection", "cream", "ointment", "gel", "drops", "inhaler", "sachet", "suspension", "solution", "powder", "lotion", "patch", "suppository", "spray"];

  constructor(table) {
    this.table      = table;
    this.colMap     = {};
    this.headers    = [];
    this.confidence = 0;
    this._mapColumns();
  }

  // ── Normalize cell text ──
  // Strips leading numbers, bullets, whitespace so "1. Paracetamol"
  // becomes "Paracetamol". Also collapses whitespace.
  _normalizeCell(text) {
    return (text || "")
      .replace(/^\s*\d+[\.\)]\s*/, "")  // "1. " or "1) " prefix
      .replace(/^[-•·]\s*/, "")         // bullet prefix
      .replace(/\s+/g, " ")
      .trim();
  }

  _mapColumns() {
    const headerRow = (
      this.table.querySelector("thead tr") ||
      this.table.querySelector("tr:first-child")
    );
    if (!headerRow) return;

    this.headers = Array.from(
      headerRow.querySelectorAll("th, td")
    ).map((el, idx) => ({
      text:     (el.innerText || el.textContent || "").trim().toLowerCase().replace(/\s+/g, " "),
      idx,
    }));

    // ── Score each field against each header ──
    let totalScore = 0;
    const maxScore = Object.values(SmartTableReader.FIELD_PATTERNS)
      .reduce((s, c) => s + c.weight, 0);

    const scored = {}; // field → { idx, score }

    for (const [field, config] of Object.entries(SmartTableReader.FIELD_PATTERNS)) {
      let bestIdx   = -1;
      let bestScore = 0;

      for (const header of this.headers) {
        for (const pattern of config.headers) {
          let score = 0;

          if (header.text === pattern) {
            // Exact match
            score = config.weight;
          } else if (header.text.includes(pattern) || pattern.includes(header.text)) {
            // Partial match — 70% credit
            score = config.weight * 0.7;
          }

          if (score > bestScore) {
            bestScore = score;
            bestIdx   = header.idx;
          }
        }
      }

      if (bestIdx >= 0) {
        scored[field] = { idx: bestIdx, score: bestScore };
        this.colMap[field] = bestIdx;
        totalScore += bestScore;
      }
    }

    // ─────────────────────────────────────────────────────────
    // BRAND / GENERIC COLLISION FIX
    // If both generic_name and brand_name mapped to same column
    // (e.g. "Name" matches both patterns), free up brand_name so
    // description disambiguation can correctly reassign generic_name.
    // ─────────────────────────────────────────────────────────
    if (this.colMap.generic_name !== undefined &&
        this.colMap.brand_name   !== undefined &&
        this.colMap.generic_name === this.colMap.brand_name) {
      const brandPatterns = SmartTableReader.FIELD_PATTERNS.brand_name.headers;
      let brandBest = -1, brandScore = 0;
      for (const hdr of this.headers) {
        if (hdr.idx === this.colMap.generic_name) continue;
        for (const pattern of brandPatterns) {
          let score = 0;
          if (hdr.text === pattern) score = SmartTableReader.FIELD_PATTERNS.brand_name.weight;
          else if (hdr.text.includes(pattern) || pattern.includes(hdr.text))
            score = SmartTableReader.FIELD_PATTERNS.brand_name.weight * 0.7;
          if (score > brandScore) { brandScore = score; brandBest = hdr.idx; }
        }
      }
      if (brandBest >= 0) this.colMap.brand_name = brandBest;
      else delete this.colMap.brand_name;
    }

    // ─────────────────────────────────────────────────────────
    // PRICE DISAMBIGUATION
    // Problem: many tables have two price columns with ambiguous
    // headers (e.g. "Price" and "Cost Price", or just two columns
    // both called "Price").
    //
    // Strategy:
    //   1. If headers clearly indicate selling vs cost → done
    //   2. If both score as "price" field → use header keyword clues
    //   3. If still ambiguous → sample first 5 data rows and assign
    //      higher average value as selling price (retail > cost)
    //   4. If still tied → leave as-is (price = first match)
    // ─────────────────────────────────────────────────────────
    this._disambiguatePrices();

    // ─────────────────────────────────────────────────────────
    // DESCRIPTION vs NAME DISAMBIGUATION
    //
    // Three scenarios:
    //   A. Only "description" column exists → use it as generic_name
    //   B. Only "name" column exists → already mapped, nothing to do
    //   C. Both exist → pick the one with longer average cell content
    //      because "Description" columns usually have the full drug
    //      name while "Name" columns are often short abbreviations
    //      (e.g. "PCM" vs "Paracetamol 500mg Tablet")
    // ─────────────────────────────────────────────────────────
    // ─────────────────────────────────────────────────────────
    // DESCRIPTION vs NAME DISAMBIGUATION
    //
    // "Description" columns have two very different meanings:
    //   A. Drug name alias  → "Paracetamol 500mg Tablet"
    //   B. Usage note       → "Used for pain relief and fever"
    //
    // We tell them apart by scanning cell values for drug name
    // signals vs natural language signals:
    //
    //   Drug name signals:
    //     - Contains a dosage pattern (500mg, 10mcg, 1g, 5ml, 2%)
    //     - Matches a known dosage form word (Tablet, Capsule, etc)
    //     - Short (1–5 words) with no verb-like words
    //
    //   Natural language signals (description/note):
    //     - Contains verb phrases ("used for", "indicated for",
    //       "treatment of", "helps with", "prescribed for")
    //     - Long sentence (>8 words)
    //     - Contains pronouns or articles ("is", "are", "the", "a")
    //
    // Decision: score each signal across first 5 rows.
    // If description column looks like drug names → use it.
    // If it looks like sentences → ignore it, keep name column.
    // ─────────────────────────────────────────────────────────

    // Drug name richness scorer — returns 0.0–1.0 based on how much
    // the text looks like a real drug name vs an abbreviation or sentence.
    // Dosage + form = 1.0 (most confident), abbreviation ≤4 chars = 0.2 (weak)
    const _drugNameScore = (text) => {
      if (!text) return 0;
      const t = text.toLowerCase().trim();
      const hasVerb = /(used for|indicated for|treatment of|helps|prescribed|relieves|reduces|prevents|belongs to|acts as|works by|given to|taken for|suitable for)/i.test(t);
      if (hasVerb) return 0;
      const wordCount = t.split(/\s+/).length;
      if (wordCount > 7) return 0;
      const hasDosage = /\d+\s*(mg|mcg|ml|g|iu|%|mcg\/ml|mg\/ml)/i.test(t);
      const hasForm   = SmartTableReader.DOSAGE_FORM_VALUES.some(f => t.includes(f));
      if (hasDosage && hasForm) return 1.0;
      if (hasDosage) return 0.9;
      if (hasForm)   return 0.8;
      if (t.length <= 4) return 0.2; // likely abbreviation (PCM, IBU, AMX)
      if (wordCount <= 3) return 0.5;
      return 0.4;
    };

    const _scoreColumnAsDrugName = (colIdx) => {
      const rows = Array.from(this.table.querySelectorAll("tbody tr")).slice(0, 5);
      if (!rows.length) return 0;
      const scores = rows.map(row => {
        const cell = row.querySelectorAll("td")[colIdx];
        return _drugNameScore((cell?.innerText || "").trim());
      });
      return scores.reduce((a, b) => a + b, 0) / scores.length;
    };

    const descHeader = this.headers.find(h =>
      h.text === "description"          ||
      h.text.includes("description")    ||
      h.text === "item"                 ||
      h.text === "article"
    );
    const nameHeader = this.headers.find(h =>
      h.text === "name"      ||
      h.text === "drug name" ||
      h.text === "item name" ||
      h.text === "medicine"
    );

    if (this.colMap.generic_name === undefined && descHeader) {
      // No name column found — check if description looks like drug names
      const descScore = _scoreColumnAsDrugName(descHeader.idx);
      if (descScore >= 0.4) {
        // At least 40% of sampled cells look like drug names → use it
        this.colMap.generic_name = descHeader.idx;
      }
      // Otherwise description is a notes/usage column — skip it entirely

    } else if (descHeader && nameHeader && this.colMap.generic_name !== undefined) {
      // Both columns exist — compare drug-name scores
      const descScore = _scoreColumnAsDrugName(descHeader.idx);
      const nameScore = _scoreColumnAsDrugName(nameHeader.idx);

      if (descScore > nameScore + 0.3) {
        // Description column is significantly more drug-name-like
        // (e.g. "Paracetamol 500mg" beats abbreviation "PCM")
        this.colMap.generic_name = descHeader.idx;
      }
      // Otherwise keep name column — description is likely a usage note
    }

    // ─────────────────────────────────────────────────────────
    // DOSAGE FORM COLUMN DETECTION
    // Some systems label this "Unit of Issue" — detect by checking
    // cell values against known dosage form strings.
    // ─────────────────────────────────────────────────────────
    if (this.colMap.dosage_form === undefined) {
      this._detectDosageFormByValues();
    }

    this.confidence = Math.round((totalScore / maxScore) * 100);
  }

  _disambiguatePrices() {
    // Find all columns that scored as either "price" or "cost_price"
    const priceHeaders = this.headers.filter(h =>
      SmartTableReader.PRICE_SELLING_CLUES.some(c => h.text.includes(c))
    );
    const costHeaders = this.headers.filter(h =>
      SmartTableReader.PRICE_COST_CLUES.some(c => h.text.includes(c))
    );

    // If both are clearly identified → assign directly
    if (priceHeaders.length > 0 && costHeaders.length > 0) {
      this.colMap.price      = priceHeaders[0].idx;
      this.colMap.cost_price = costHeaders[0].idx;
      return;
    }

    // If price and cost_price mapped to same column → try to find a second price column
    if (this.colMap.price !== undefined &&
        this.colMap.cost_price !== undefined &&
        this.colMap.price === this.colMap.cost_price) {

      // Find all numeric-looking columns
      const numericCols = this._findNumericColumns();
      if (numericCols.length >= 2) {
        // Sample values to decide which is selling price
        const [colA, colB] = numericCols.slice(0, 2);
        const avgA = this._avgColumnValue(colA);
        const avgB = this._avgColumnValue(colB);
        // Higher average = selling price (retail > cost)
        this.colMap.price      = avgA >= avgB ? colA : colB;
        this.colMap.cost_price = avgA >= avgB ? colB : colA;
      }
    }

    // Scenario E fix: two headers both score as "price" — second never gets mapped.
    // Detect all columns matching price patterns; if cost_price still unset
    // and two price-like columns exist, split by average cell value.
    if (this.colMap.cost_price === undefined && this.colMap.price !== undefined) {
      const pricePatterns = SmartTableReader.FIELD_PATTERNS.price.headers;
      const allPriceCols = this.headers.filter(h =>
        pricePatterns.some(p => h.text === p || h.text.includes(p) || p.includes(h.text))
      );
      if (allPriceCols.length >= 2) {
        const withAvg = allPriceCols.map(h => ({
          idx: h.idx,
          avg: this._avgColumnValue(h.idx),
        })).sort((a, b) => b.avg - a.avg);
        this.colMap.price      = withAvg[0].idx;
        this.colMap.cost_price = withAvg[1].idx;
      }
    }
    // If only one price column found — it's the selling price
    // cost_price stays undefined (not available in this table)
  }

  _findNumericColumns() {
    // Returns column indices that appear to contain numeric values
    const rows = Array.from(this.table.querySelectorAll("tbody tr")).slice(0, 5);
    const numericCols = [];
    if (!rows.length) return numericCols;

    const cellCount = rows[0].querySelectorAll("td").length;
    for (let i = 0; i < cellCount; i++) {
      const values = rows.map(row => {
        const cell = row.querySelectorAll("td")[i];
        return parseFloat((cell?.innerText || "").replace(/[₦,\s]/g, "")) || 0;
      });
      const hasValues = values.some(v => v > 0);
      if (hasValues) numericCols.push(i);
    }
    return numericCols;
  }

  _avgColumnValue(colIdx) {
    const rows = Array.from(this.table.querySelectorAll("tbody tr")).slice(0, 5);
    const vals = rows.map(row => {
      const cell = row.querySelectorAll("td")[colIdx];
      return parseFloat((cell?.innerText || "").replace(/[₦,\s]/g, "")) || 0;
    }).filter(v => v > 0);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }

  _detectDosageFormByValues() {
    // Scan first 5 data rows — if a column has values matching
    // known dosage forms (Tablet, Capsule, etc), assign it
    const rows = Array.from(this.table.querySelectorAll("tbody tr")).slice(0, 5);
    if (!rows.length) return;

    const cellCount = rows[0].querySelectorAll("td").length;
    for (let i = 0; i < cellCount; i++) {
      const matches = rows.filter(row => {
        const cell = row.querySelectorAll("td")[i];
        const val = (cell?.innerText || "").trim().toLowerCase();
        return SmartTableReader.DOSAGE_FORM_VALUES.some(f => val === f || val.startsWith(f));
      });
      if (matches.length >= 2) {
        this.colMap.dosage_form = i;
        return;
      }
    }
  }

  readRows() {
    const rows  = this.table.querySelectorAll("tbody tr");
    const drugs = [];
    const utils = window.MyApotiUtils;

    rows.forEach((row) => {
      const cells = row.querySelectorAll("td");
      if (cells.length < 2) return;

      const get = (field) => {
        const idx = this.colMap[field];
        if (idx === undefined || idx >= cells.length) return null;
        return this._normalizeCell(cells[idx]?.innerText || null);
      };

      // Name: prefer generic_name, fall back to brand_name
      const rawName = get("generic_name") || get("brand_name");
      if (!rawName) return;

      // Strip strength/form suffixes embedded in drug name column
      // e.g. "Paracetamol 500mg Tablet" → keep as-is (MyApoti handles it)
      // but "Paracetamol (500mg)" → "Paracetamol (500mg)" (keep parenthetical)
      const name = rawName;

      // Price: selling price required
      const price = utils.parsePrice(get("price"));
      if (!price || price <= 0) return;

      // Quantity
      const qtyRaw   = get("quantity") || "0";
      const quantity = parseInt(qtyRaw.replace(/[^0-9]/g, "") || "0");

      // Cost price — optional, validate it's lower than selling price
      // If cost > selling, the columns may be swapped — ignore cost
      let cost_price = utils.parsePrice(get("cost_price"));
      if (cost_price && cost_price > price * 2) {
        // Cost > 2× selling = almost certainly a mapping error
        cost_price = null;
      }

      // Expiry date — try to parse, discard unparseable values
      const expiry_raw = get("expiry_date");
      const expiration_date = expiry_raw ? utils.parseDate(expiry_raw) : null;

      // Dosage form — validate against known values
      const form_raw   = get("dosage_form");
      const dosage_form = form_raw && SmartTableReader.DOSAGE_FORM_VALUES.some(
        f => form_raw.toLowerCase().includes(f)
      ) ? form_raw : null;

      // Strength — only include if it looks like a real strength
      // (contains a number + unit, e.g. "500mg", "10mcg")
      const strength_raw = get("strength");
      const strength = strength_raw && /\d/.test(strength_raw) ? strength_raw : null;

      drugs.push({
        generic_name:    name,
        brand_name:      get("brand_name"),
        quantity,
        price,
        cost_price,
        category:        get("category"),
        strength,
        dosage_form,
        expiration_date,
        nafdac_number:   get("barcode"),
        manufacturer:    get("manufacturer"),
        pack_size:       get("pack_size"),
      });
    });

    return { drugs, confidence: this.confidence };
  }

  isInventoryTable() {
    return (
      this.colMap.price        !== undefined ||
      this.colMap.quantity     !== undefined ||
      this.colMap.generic_name !== undefined
    ) && this.confidence >= 20;
  }

  isBillingTable() {
    const headerTexts = this.headers.map(h => h.text);
    return headerTexts.some(h =>
      h.includes("total")        ||
      h.includes("qty sold")     ||
      h.includes("dispensed")    ||
      h.includes("amount paid")
    );
  }
};


// ── Smart Form Reader ──
window.SmartFormReader = class SmartFormReader {

  constructor(form) {
    this.form     = form;
    this.fieldMap = {};
    this._mapFields();
  }

  _mapFields() {
    const inputs = this.form.querySelectorAll(
      "input:not([type='hidden']):not([type='submit'])" +
      ":not([type='button']), select, textarea"
    );

    inputs.forEach((input) => {
      const label    = this._findLabel(input)?.toLowerCase() || "";
      const name     = (input.name || input.id || "").toLowerCase();
      const ph       = (input.placeholder || "").toLowerCase();
      const combined = `${label} ${name} ${ph}`;

      for (const [field, config] of Object.entries(
        SmartTableReader.FIELD_PATTERNS
      )) {
        for (const pattern of config.headers) {
          if (combined.includes(pattern) && !this.fieldMap[field]) {
            this.fieldMap[field] = input;
            break;
          }
        }
      }
    });
  }

  _findLabel(input) {
    if (input.id) {
      const label = document.querySelector(`label[for="${input.id}"]`);
      if (label) return label.innerText;
    }
    const parent = input.closest(".form-group, .field, .input-group, label");
    if (parent) {
      const label = parent.querySelector("label");
      if (label && label !== input) return label.innerText;
    }
    return input.placeholder || input.name || "";
  }

  readValues() {
    const result = {};
    for (const [field, input] of Object.entries(this.fieldMap)) {
      result[field] = input.value?.trim() || null;
    }
    return result;
  }
};