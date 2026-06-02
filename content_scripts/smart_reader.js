// smart_reader.js
// Intelligently reads any pharmacy table or form
// Maps columns to MyApoti fields automatically

window.SmartTableReader = class SmartTableReader {

  static FIELD_PATTERNS = {
    generic_name: {
      headers: [
        "description", "generic name", "generic",
        "drug name", "medicine name", "product name",
        "item name", "name", "inn", "active ingredient",
        "drug description", "item description",
      ],
      weight: 10,
    },
    brand_name: {
      headers: [
        "brand name", "brand", "trade name",
        "proprietary name", "product brand",
      ],
      weight: 8,
    },
    quantity: {
      headers: [
        "quantity", "qty", "stock", "in stock",
        "available", "balance", "on hand",
        "current stock", "stock level", "stock qty",
        "quantity available", "quantity on hand",
      ],
      weight: 10,
    },
    price: {
      headers: [
        "selling price", "sale price", "retail price",
        "unit price", "price", "amount", "general price",
        "dispensing price", "customer price", "sell price",
      ],
      weight: 10,
    },
    cost_price: {
      headers: [
        "cost price", "cost", "purchase price",
        "buy price", "landed cost", "unit cost price",
        "supplier price", "buying price",
      ],
      weight: 8,
    },
    expiry_date: {
      headers: [
        "expiry date", "expiration date", "expiry",
        "best before", "use by", "exp date",
        "expire", "expiration",
      ],
      weight: 7,
    },
    category: {
      headers: [
        "category", "group", "type", "class",
        "drug class", "classification", "department",
        "product group", "therapeutic class",
        "drug formulation", "drug classification",
      ],
      weight: 5,
    },
    strength: {
      headers: [
        "strength", "dosage", "concentration",
        "dose", "potency", "strength/dose",
      ],
      weight: 5,
    },
    dosage_form: {
      headers: [
        "dosage form", "form", "formulation",
        "drug form", "presentation",
      ],
      weight: 4,
    },
    barcode: {
      headers: [
        "barcode", "sku", "code", "product code",
        "nafdac", "nafdac no", "nafdac number",
        "reg no", "registration number", "item code",
        "stock code",
      ],
      weight: 5,
    },
    manufacturer: {
      headers: [
        "manufacturer", "supplier", "vendor",
        "made by", "brand company", "company",
        "manufactured by",
      ],
      weight: 4,
    },
    pack_size: {
      headers: [
        "pack size", "packing", "unit",
        "unit of issue", "unit of measure",
        "uom", "packs per unit",
      ],
      weight: 3,
    },
  };

  constructor(table) {
    this.table      = table;
    this.colMap     = {};
    this.headers    = [];
    this.confidence = 0;
    this._mapColumns();
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
      text: el.innerText.trim().toLowerCase(),
      idx,
    }));

    let totalScore = 0;
    const maxScore = Object.values(
      SmartTableReader.FIELD_PATTERNS
    ).reduce((s, c) => s + c.weight, 0);

    for (const [field, config] of Object.entries(
      SmartTableReader.FIELD_PATTERNS
    )) {
      let bestIdx   = -1;
      let bestScore = 0;

      for (const header of this.headers) {
        for (const pattern of config.headers) {
          let score = 0;

          if (header.text === pattern) {
            score = config.weight;
          } else if (
            header.text.includes(pattern) ||
            pattern.includes(header.text)
          ) {
            score = config.weight * 0.7;
          }

          if (score > bestScore) {
            bestScore = score;
            bestIdx   = header.idx;
          }
        }
      }

      if (bestIdx >= 0) {
        this.colMap[field] = bestIdx;
        totalScore += bestScore;
      }
    }

    this.confidence = Math.round(
      (totalScore / maxScore) * 100
    );
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
        if (idx === undefined || idx >= cells.length)
          return null;
        return cells[idx]?.innerText?.trim() || null;
      };

      const name = get("generic_name") || get("brand_name");
      if (!name) return;

      const price = utils.parsePrice(get("price"));
      if (!price || price <= 0) return;

      const qtyRaw  = get("quantity") || "0";
      const quantity = parseInt(
        qtyRaw.replace(/[^0-9]/g, "") || "0"
      );

      drugs.push({
        generic_name:    get("generic_name") || name,
        brand_name:      get("brand_name"),
        quantity,
        price,
        cost_price:      utils.parsePrice(get("cost_price")),
        category:        get("category"),
        strength:        get("strength"),
        dosage_form:     get("dosage_form"),
        expiration_date: utils.parseDate(get("expiry_date")),
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
      const label = this._findLabel(input)?.toLowerCase() || "";
      const name  = (input.name || input.id || "").toLowerCase();
      const ph    = (input.placeholder || "").toLowerCase();
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
      const label = document.querySelector(
        `label[for="${input.id}"]`
      );
      if (label) return label.innerText;
    }
    const parent = input.closest(
      ".form-group, .field, .input-group, label"
    );
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