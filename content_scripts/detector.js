// detector.js
// Detects if current page is a pharmacy/HMIS app
// and identifies what type of page it is

window.MyApotiDetector = {

  // ── Known pharmacy platforms ──
  KNOWN_PLATFORMS: {
    "healthstation.ng": { name: "Dulos HMIS",  confidence: 100 },
    "virtualrx.ng":     { name: "VirtualRx",   confidence: 100 },
    "medpoint":         { name: "MedPoint",    confidence: 90  },
    "quickpharm":       { name: "QuickPharm",  confidence: 90  },
    "pharmsoft":        { name: "PharmaSoft",  confidence: 90  },
    "clinikehr":        { name: "ClinikEHR",   confidence: 90  },
    "healthplus":       { name: "HealthPlus",  confidence: 85  },
  },

  // ── Signals that indicate a pharmacy app ──
  PHARMACY_SIGNALS: {
    url: [
      "pharmacy", "pharma", "drug", "medicine",
      "hmis", "healthstation", "virtualrx",
      "dispensary", "chemist", "apothecary",
      "drugstore", "medpoint", "quickpharm",
      "pharmsoft", "healthplus",
    ],
    title: [
      "pharmacy", "drug register", "inventory",
      "dispensary", "pos", "billing", "medicine",
      "pharmaceutical", "hmis", "drug store",
    ],
    dom: [
      "nafdac", "generic name", "brand name",
      "dosage form", "drug register", "dispensing",
      "selling price", "cost price", "expiry date",
      "stock level", "reorder level", "pharmacist",
      "drug classification", "drug formulation",
    ],
  },

  // ── Page type signals ──
  PAGE_SIGNALS: {
    inventory: [
      "drug register", "inventory", "stock list",
      "products", "medicines", "formulary",
      "drug list", "item list", "stock management",
    ],
    billing: [
      "billing", "sales", "pos", "point of sale",
      "walk-in", "walkin", "checkout", "invoice",
      "dispense", "transaction", "receipt", "sell",
    ],
    stock_receipt: [
      "receive", "purchase", "supply", "restock",
      "goods received", "stock in", "procurement",
      "receive approved", "receive goods",
    ],
    add_edit_drug: [
      "add drug", "add product", "new drug",
      "add inventory", "edit drug", "update drug",
      "add item", "new product",
    ],
  },

  // ── Detect known platform by URL ──
  detectKnownPlatform() {
    const url = window.location.hostname.toLowerCase();
    for (const [domain, info] of Object.entries(this.KNOWN_PLATFORMS)) {
      if (url.includes(domain)) return info;
    }
    return null;
  },

  // ── Score-based pharmacy detection ──
  isPharmacyApp() {
    const known = this.detectKnownPlatform();
    if (known) return true;

    const url   = window.location.href.toLowerCase();
    const title = document.title.toLowerCase();
    const body  = (document.body?.innerText || "")
                    .toLowerCase()
                    .slice(0, 5000);

    let score = 0;

    for (const kw of this.PHARMACY_SIGNALS.url) {
      if (url.includes(kw)) score += 3;
    }
    for (const kw of this.PHARMACY_SIGNALS.title) {
      if (title.includes(kw)) score += 2;
    }
    for (const kw of this.PHARMACY_SIGNALS.dom) {
      if (body.includes(kw)) score += 1;
    }

    return score >= 4;
  },

  // ── Detect what type of page this is ──
  detectPageType() {
    const url   = window.location.href.toLowerCase();
    const hash  = window.location.hash.toLowerCase();
    const title = document.title.toLowerCase();
    const body  = (document.body?.innerText || "")
                    .toLowerCase()
                    .slice(0, 3000);

    const full   = url + hash + title + body;
    const scores = {};

    for (const [type, keywords] of Object.entries(this.PAGE_SIGNALS)) {
      scores[type] = keywords.filter(kw => full.includes(kw)).length;
    }

    const winner = Object.entries(scores)
      .sort((a, b) => b[1] - a[1])[0];

    return winner && winner[1] > 0 ? winner[0] : "unknown";
  },

  // ── Get platform display name ──
  getPlatformName() {
    const known = this.detectKnownPlatform();
    if (known) return known.name;
    return `Web HMIS (${window.location.hostname})`;
  },
};