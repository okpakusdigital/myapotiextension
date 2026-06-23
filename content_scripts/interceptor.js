// content_scripts/interceptor.js
// Runs at document_start — before any page scripts load.
//
// Architecture: store-then-confirm
//   1. Outgoing POST request → body stored in memory
//   2. Response arrives → if 200 OK, retrieve stored body + sync
//                         if 4xx/5xx, discard stored body
//
// This guarantees:
//   - Only server-confirmed transactions reach MyApoti
//   - Response doesn't need to contain item data (most don't)
//   - Works for JSON, form-encoded, and FormData bodies
//   - WebSocket: store outgoing, confirm on incoming success message

(function () {
  "use strict";

  const EXPIRY_MS = 30 * 1000;

  // ── MyApoti's own backend — NEVER intercept these ──
  // interceptor.js exists to watch the *HMIS's* network traffic (the
  // pharmacy software's own sale/stock/drug endpoints), not the
  // extension's own outgoing calls to its own backend. Without this
  // exclusion, content.js's call to /extension/sync-inventory (and any
  // other /extension/* or /pharmacies/* call utils.js makes) gets
  // re-captured here too, because "inventory" is also one of
  // DRUG_KEYWORDS. That re-capture then gets dispatched as a second,
  // bogus myapoti_capture "drug" event wrapping the extension's own
  // sync request/response — today it's harmless because the payload
  // shape ({source, drugs: [...]}) doesn't match handleCapturedDrug's
  // single-drug field expectations, so it just logs "name missing,
  // skipping" — but that's accidental, not by design, and a future
  // payload or endpoint change could turn this into a real duplicate
  // sync. Excluding MyApoti's own hosts closes the gap at the source.
  const MYAPOTI_BACKEND_HOSTS = [
    "127.0.0.1:8000",
    "localhost:8000",
  ];

  function isMyApotiBackendUrl(url) {
    try {
      return MYAPOTI_BACKEND_HOSTS.some(host => url.includes(host));
    } catch {
      return false;
    }
  }

  const pendingRequests = new Map();
  const pendingWsMessages = new Map();

  function storeRequest(requestId, url, body, type, method) {
    pendingRequests.set(requestId, {
      url,
      body,
      type,
      method,   // ← store HTTP method so universal.js can distinguish POST vs PUT
      timestamp: Date.now(),
    });
    setTimeout(() => pendingRequests.delete(requestId), EXPIRY_MS);
  }

  function consumeRequest(requestId) {
    const entry = pendingRequests.get(requestId);
    if (entry) pendingRequests.delete(requestId);
    return entry || null;
  }

  function generateId() {
    return Math.random().toString(36).slice(2) + Date.now();
  }

  const SALE_KEYWORDS = [
    "sale", "billing", "invoice", "dispense",
    "checkout", "payment", "transaction", "sell",
    "pos", "receipt", "complete", "finalize",
  ];

  const STOCK_KEYWORDS = [
    "receive", "stock", "purchase", "supply",
    "procurement", "goods", "restock", "stock-in",
  ];

  const DRUG_KEYWORDS = [
    "drug", "product", "medicine", "item",
    "inventory", "formulary", "add-drug",
  ];

  function classifyUrl(url) {
    const lower = url.toLowerCase();
    if (SALE_KEYWORDS.some(kw  => lower.includes(kw)))  return "sale";
    if (STOCK_KEYWORDS.some(kw => lower.includes(kw)))  return "stock_receipt";
    if (DRUG_KEYWORDS.some(kw  => lower.includes(kw)))  return "drug";
    return null;
  }

  function classifyMessage(msgType) {
    if (SALE_KEYWORDS.some(kw  => msgType.includes(kw))) return "sale";
    if (STOCK_KEYWORDS.some(kw => msgType.includes(kw))) return "stock_receipt";
    if (DRUG_KEYWORDS.some(kw  => msgType.includes(kw))) return "drug";
    return null;
  }

  async function parseBody(body) {
    if (!body) return null;
    try {
      if (typeof body === "string") {
        try { return JSON.parse(body); } catch {}
        try { return Object.fromEntries(new URLSearchParams(body)); } catch {}
        return { raw: body };
      }
      if (body instanceof FormData)       return Object.fromEntries(body);
      if (body instanceof URLSearchParams) return Object.fromEntries(body);
      if (body instanceof Blob || body instanceof ArrayBuffer) {
        const text = await new Response(body).text().catch(() => null);
        if (text) {
          try { return JSON.parse(text); } catch {}
          return { raw: text };
        }
      }
    } catch {}
    return null;
  }

  // ── Fire captured data to universal.js ──
  // Now includes __method so universal.js knows POST vs PUT/PATCH
  function dispatchCapture(type, url, requestBody, responseBody, method) {
    window.dispatchEvent(new CustomEvent("myapoti_capture", {
      detail: {
        type,
        url,
        method: method || "POST",   // ← HTTP method passed through
        payload: {
          request:  requestBody,
          response: responseBody,
        },
      },
    }));
  }


  // ══════════════════════════════════════════════════════
  // FETCH INTERCEPTOR
  // ══════════════════════════════════════════════════════
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const [resource, options] = args;
    const url    = typeof resource === "string" ? resource : resource?.url || "";
    const method = (options?.method || "GET").toUpperCase();

    let requestId = null;

    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      const excluded = isMyApotiBackendUrl(url);
      console.log(`%c[DEBUG] interceptor fetch check — method=${method} url=${url} isMyApotiBackend=${excluded}`, "background:#ff8800;color:#000;padding:2px 6px;border-radius:3px;font-weight:bold");
      if (!excluded) {
        const type = classifyUrl(url);
        if (type) {
          requestId = generateId();
          const parsedBody = method === "DELETE"
            ? { __delete: true, __url: url }
            : await parseBody(options?.body);
          storeRequest(requestId, url, parsedBody, type, method);  // ← pass method
        }
      }
    }

    const response = await originalFetch.apply(this, args);

    if (requestId) {
      if (response.ok) {
        const stored = consumeRequest(requestId);
        if (stored) {
          try {
            const clone        = response.clone();
            const responseBody = await clone.json().catch(() => null);
            dispatchCapture(stored.type, url, stored.body, responseBody, stored.method);  // ← pass method
          } catch {}
        }
      } else {
        consumeRequest(requestId);
      }
    }

    return response;
  };


  // ══════════════════════════════════════════════════════
  // XMLHTTPREQUEST INTERCEPTOR
  // ══════════════════════════════════════════════════════
  const OriginalXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = class extends OriginalXHR {
    open(method, url, ...rest) {
      this._url    = url;
      this._method = method;
      this._xhrId  = null;
      super.open(method, url, ...rest);
    }

    send(body) {
      if (["POST", "PUT", "PATCH", "DELETE"].includes(this._method?.toUpperCase()) && !isMyApotiBackendUrl(this._url)) {
        const type = classifyUrl(this._url);
        if (type) {
          this._xhrId = generateId();
          const id     = this._xhrId;
          const url    = this._url;
          const method = this._method?.toUpperCase();
          if (method === "DELETE") {
            storeRequest(id, url, { __delete: true, __url: url }, type, method);  // ← pass method
          } else {
            parseBody(body).then(parsedBody => {
              storeRequest(id, url, parsedBody, type, method);  // ← pass method
            });
          }
        }
      }

      this.addEventListener("load", () => {
        if (!this._xhrId) return;

        if (this.status >= 200 && this.status < 300) {
          const stored = consumeRequest(this._xhrId);
          if (stored) {
            try {
              const responseBody = JSON.parse(this.responseText);
              dispatchCapture(stored.type, this._url, stored.body, responseBody, stored.method);  // ← pass method
            } catch {
              dispatchCapture(stored.type, this._url, stored.body, null, stored.method);
            }
          }
        } else {
          consumeRequest(this._xhrId);
        }
      });

      this.addEventListener("error", () => {
        if (this._xhrId) consumeRequest(this._xhrId);
      });

      super.send(body);
    }
  };


  // ══════════════════════════════════════════════════════
  // WEBSOCKET INTERCEPTOR
  // ══════════════════════════════════════════════════════
  const OriginalWebSocket = window.WebSocket;
  window.WebSocket = class extends OriginalWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      this._wsUrl = url;

      const originalSend = this.send.bind(this);
      this.send = (data) => {
        try {
          const parsed = typeof data === "string" ? JSON.parse(data) : null;
          if (parsed) {
            const msgType = (parsed.type || parsed.action || "").toLowerCase();
            const type    = classifyMessage(msgType);
            if (type) {
              const msgId = "ws_" + generateId();
              pendingWsMessages.set(msgId, {
                url:    this._wsUrl,
                body:   parsed,
                type,
                method: "WS",
                timestamp: Date.now(),
              });
              parsed.__myapoti_id = msgId;
              setTimeout(() => pendingWsMessages.delete(msgId), EXPIRY_MS);
            }
          }
        } catch {}
        return originalSend(data);
      };

      this.addEventListener("message", (event) => {
        try {
          const data = typeof event.data === "string"
            ? JSON.parse(event.data)
            : null;
          if (!data) return;

          const isSuccess =
            data.success === true          ||
            data.status  === "success"     ||
            data.status  === "ok"          ||
            data.status  === 200           ||
            (data.type || "").toLowerCase().includes("confirmed")  ||
            (data.type || "").toLowerCase().includes("completed");

          if (!isSuccess) {
            if (data.__myapoti_id) pendingWsMessages.delete(data.__myapoti_id);
            return;
          }

          if (data.__myapoti_id && pendingWsMessages.has(data.__myapoti_id)) {
            const stored = pendingWsMessages.get(data.__myapoti_id);
            pendingWsMessages.delete(data.__myapoti_id);
            dispatchCapture(stored.type, stored.url, stored.body, data, stored.method);
            return;
          }

          const confirmType = (data.type || data.action || data.event || "").toLowerCase();
          const type = classifyMessage(confirmType);
          if (type) {
            let matchId = null, matchMsg = null, latest = 0;
            for (const [id, msg] of pendingWsMessages) {
              if (msg.type === type && msg.timestamp > latest) {
                latest = msg.timestamp; matchId = id; matchMsg = msg;
              }
            }
            if (matchId) {
              pendingWsMessages.delete(matchId);
              dispatchCapture(type, this._wsUrl, matchMsg.body, data, matchMsg.method);
            } else {
              dispatchCapture(type, this._wsUrl, null, data, "WS");
            }
          }
        } catch {}
      });
    }
  };

})();