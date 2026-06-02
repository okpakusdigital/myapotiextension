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

  // ══════════════════════════════════════════════════════
  // IN-MEMORY REQUEST STORE
  // Stores outgoing POST bodies keyed by a request ID.
  // Entries expire after 30 seconds to prevent memory leaks
  // from requests that never get a response (network failure,
  // tab closed mid-request, etc.)
  // ══════════════════════════════════════════════════════
  const EXPIRY_MS = 30 * 1000; // 30 seconds

  const pendingRequests = new Map();
  // Map<requestId, { url, body, type, timestamp }>

  function storeRequest(requestId, url, body, type) {
    pendingRequests.set(requestId, {
      url,
      body,
      type,
      timestamp: Date.now(),
    });

    // Auto-expire after 30s — clean up unanswered requests
    setTimeout(() => {
      pendingRequests.delete(requestId);
    }, EXPIRY_MS);
  }

  function consumeRequest(requestId) {
    const entry = pendingRequests.get(requestId);
    if (entry) pendingRequests.delete(requestId);
    return entry || null;
  }

  // WebSocket pending outgoing messages
  // Keyed by message hash since WS has no request ID
  const pendingWsMessages = new Map();

  function generateId() {
    return Math.random().toString(36).slice(2) + Date.now();
  }

  // ── Keywords that identify endpoint types ──
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

  // ── Parse request body — handles JSON, form-encoded, FormData ──
  async function parseBody(body) {
    if (!body) return null;
    try {
      if (typeof body === "string") {
        // Try JSON first
        try { return JSON.parse(body); } catch {}
        // Try URL-encoded form data (key=value&key2=value2)
        try { return Object.fromEntries(new URLSearchParams(body)); } catch {}
        return { raw: body };
      }
      if (body instanceof FormData) {
        return Object.fromEntries(body);
      }
      if (body instanceof URLSearchParams) {
        return Object.fromEntries(body);
      }
      if (body instanceof Blob || body instanceof ArrayBuffer) {
        // Binary body — read as text and try JSON
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
  function dispatchCapture(type, url, requestBody, responseBody) {
    window.dispatchEvent(new CustomEvent("myapoti_capture", {
      detail: {
        type,
        url,
        payload: {
          request:  requestBody,   // what was sent — has the items
          response: responseBody,  // server confirmation — has status
        },
      },
    }));
  }


  // ══════════════════════════════════════════════════════
  // FETCH INTERCEPTOR
  //
  // Store outgoing request body in memory on send.
  // On response: if 200 OK → retrieve stored body → dispatch.
  //              if error  → discard stored body.
  // ══════════════════════════════════════════════════════
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const [resource, options] = args;
    const url    = typeof resource === "string" ? resource : resource?.url || "";
    const method = (options?.method || "GET").toUpperCase();

    let requestId = null;

    // Store outgoing POST body before sending
    if (method === "POST") {
      const type = classifyUrl(url);
      if (type) {
        requestId = generateId();
        // Parse body asynchronously — don't block the request
        parseBody(options?.body).then(parsedBody => {
          storeRequest(requestId, url, parsedBody, type);
        });
      }
    }

    // Send the real request
    const response = await originalFetch.apply(this, args);

    // On response — check if we stored a request for this
    if (requestId) {
      if (response.ok) {
        // 200 OK — retrieve stored request body and dispatch
        const stored = consumeRequest(requestId);
        if (stored) {
          try {
            const clone        = response.clone();
            const responseBody = await clone.json().catch(() => null);
            dispatchCapture(stored.type, url, stored.body, responseBody);
          } catch {}
        }
      } else {
        // Server rejected — discard stored body, never sync
        consumeRequest(requestId);
      }
    }

    return response; // always return original response to page
  };


  // ══════════════════════════════════════════════════════
  // XMLHTTPREQUEST INTERCEPTOR
  //
  // Store outgoing request body in send().
  // On load event: if 2xx → retrieve stored body → dispatch.
  //                if error → discard.
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
      // Store outgoing POST body
      if (this._method?.toUpperCase() === "POST") {
        const type = classifyUrl(this._url);
        if (type) {
          this._xhrId = generateId();
          const id    = this._xhrId;
          const url   = this._url;
          parseBody(body).then(parsedBody => {
            storeRequest(id, url, parsedBody, type);
          });
        }
      }

      // Listen for response
      this.addEventListener("load", () => {
        if (!this._xhrId) return;

        if (this.status >= 200 && this.status < 300) {
          // 2xx — retrieve stored body and dispatch
          const stored = consumeRequest(this._xhrId);
          if (stored) {
            try {
              const responseBody = JSON.parse(this.responseText);
              dispatchCapture(stored.type, this._url, stored.body, responseBody);
            } catch {
              // Response not JSON — dispatch with null response
              const stored2 = consumeRequest(this._xhrId);
              if (stored2) {
                dispatchCapture(stored2.type, this._url, stored2.body, null);
              }
            }
          }
        } else {
          // Error — discard stored body, never sync
          consumeRequest(this._xhrId);
        }
      });

      // Discard on network error too
      this.addEventListener("error", () => {
        if (this._xhrId) consumeRequest(this._xhrId);
      });

      super.send(body);
    }
  };


  // ══════════════════════════════════════════════════════
  // WEBSOCKET INTERCEPTOR
  //
  // Store outgoing messages in memory.
  // Match with incoming confirmation messages.
  // Only dispatch when server confirms success.
  // ══════════════════════════════════════════════════════
  const OriginalWebSocket = window.WebSocket;
  window.WebSocket = class extends OriginalWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      this._wsUrl = url;

      // ── Intercept outgoing send — store in memory ──
      const originalSend = this.send.bind(this);
      this.send = (data) => {
        try {
          const parsed = typeof data === "string" ? JSON.parse(data) : null;
          if (parsed) {
            const msgType = (parsed.type || parsed.action || "").toLowerCase();
            const type    = classifyMessage(msgType);
            if (type) {
              // Store keyed by a hash of the message content
              const msgId = "ws_" + generateId();
              pendingWsMessages.set(msgId, {
                url:  this._wsUrl,
                body: parsed,
                type,
                timestamp: Date.now(),
              });
              // Tag the message so we can match the confirmation
              parsed.__myapoti_id = msgId;

              // Auto-expire after 30s
              setTimeout(() => pendingWsMessages.delete(msgId), EXPIRY_MS);
            }
          }
        } catch {}
        return originalSend(data);
      };

      // ── Intercept incoming — server confirmations ──
      this.addEventListener("message", (event) => {
        try {
          const data = typeof event.data === "string"
            ? JSON.parse(event.data)
            : null;
          if (!data) return;

          // Check if server confirmed success
          const isSuccess =
            data.success === true          ||
            data.status  === "success"     ||
            data.status  === "ok"          ||
            data.status  === 200           ||
            (data.type || "").toLowerCase().includes("confirmed")  ||
            (data.type || "").toLowerCase().includes("completed");

          if (!isSuccess) {
            // Server rejected — if it echoes the request ID, discard
            if (data.__myapoti_id) {
              pendingWsMessages.delete(data.__myapoti_id);
            }
            return;
          }

          // Match confirmation with stored outgoing message
          // Strategy 1: server echoes the __myapoti_id we tagged
          if (data.__myapoti_id && pendingWsMessages.has(data.__myapoti_id)) {
            const stored = pendingWsMessages.get(data.__myapoti_id);
            pendingWsMessages.delete(data.__myapoti_id);
            dispatchCapture(stored.type, stored.url, stored.body, data);
            return;
          }

          // Strategy 2: match by message type in the confirmation
          const confirmType = (data.type || data.action || data.event || "").toLowerCase();
          const type = classifyMessage(confirmType);
          if (type) {
            // Find the most recent pending message of the same type
            let matchId  = null;
            let matchMsg = null;
            let latest   = 0;
            for (const [id, msg] of pendingWsMessages) {
              if (msg.type === type && msg.timestamp > latest) {
                latest   = msg.timestamp;
                matchId  = id;
                matchMsg = msg;
              }
            }
            if (matchId) {
              pendingWsMessages.delete(matchId);
              dispatchCapture(type, this._wsUrl, matchMsg.body, data);
            } else {
              // No stored outgoing found — dispatch with response only
              dispatchCapture(type, this._wsUrl, null, data);
            }
          }

        } catch {}
      });
    }
  };

})();     