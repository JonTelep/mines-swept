// Signing and Resend contact calls for the minesSwept list.
// NEWSLETTER_SECRET, RESEND_API_KEY, and RESEND_SEGMENT_ID are Worker secrets.
// This module does not send mail. The contact helper refuses /emails.

export const SITE = "https://minesswept.com";
export const REPLY_TO = "jon@telep.io";
export const ADDRESS = "PO Box 187, Valley City, OH 44280";
export const STATUS_KEY = "minesswept_status";
export const ACTIVE = "active";
export const UNSUBSCRIBED = "unsubscribed";

const enc = new TextEncoder();

const b64u = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const b64uStr = (s) => b64u(enc.encode(s));

const unb64uStr = (s) =>
  new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

// Token: base64url(email).issuedMs.sig ; sig = HMAC(secret, action|email|issuedMs)
export async function signToken(secret, action, email, issued = Date.now()) {
  const e = b64uStr(email.toLowerCase());
  return `${e}.${issued}.${await hmac(secret, `${action}|${email.toLowerCase()}|${issued}`)}`;
}

export async function verifyToken(secret, action, token, ttlMs = 0) {
  try {
    if (!secret) return null;
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    const [e, issued, sig] = parts;
    const email = unb64uStr(e);
    const expect = await hmac(secret, `${action}|${email}|${issued}`);
    if (!sig || sig.length !== expect.length) return null;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expect.charCodeAt(i);
    if (diff) return null;
    if (ttlMs && Date.now() - Number(issued) > ttlMs) return null;
    return email;
  } catch {
    return null;
  }
}

export const unsubUrl = async (secret, email) =>
  `${SITE}/api/unsubscribe?t=${encodeURIComponent(await signToken(secret, "unsub", email, 0))}`;

export function segmentId(env) {
  const id = String((env && env.RESEND_SEGMENT_ID) || "").trim();
  return id || null;
}

export function resend(key, fetchFn = fetch) {
  return async (method, path, body) => {
    if (path === "/emails" || path.startsWith("/emails/") || path.startsWith("/emails?")) {
      throw new Error("minesswept does not send email");
    }
    const r = await fetchFn("https://api.resend.com" + path, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "User-Agent": "minesswept",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try {
      data = await r.json();
    } catch {
      data = null;
    }
    return { ok: r.ok, status: r.status, data };
  };
}

export function statusOf(contact) {
  const raw = contact && contact.properties && contact.properties[STATUS_KEY];
  if (!raw) return "none";
  if (typeof raw === "string") return raw;
  return raw.value || "none";
}

export const isActive = (contact) => !!contact && contact.unsubscribed === false && statusOf(contact) === ACTIVE;

// Global unsubscribed flag or this list's own status. Either one blocks a new signup.
export const isUnsubscribed = (contact) =>
  !!contact && (contact.unsubscribed === true || statusOf(contact) === UNSUBSCRIBED);

export function emailFooterHtml(unsub) {
  return `<hr style="border:0;border-top:1px solid #ddd;margin:28px 0 12px"><p style="font:12px/1.5 Menlo,Consolas,monospace;color:#666;margin:0">minesSwept, from Telep IO LLC. ${ADDRESS}.<br>You get this because you signed up at minesswept.com. <a href="${unsub}" style="color:#666">Unsubscribe</a></p>`;
}

export const emailFooterText = (unsub) =>
  `\n\n--\nminesSwept, from Telep IO LLC. ${ADDRESS}.\nUnsubscribe: ${unsub}\n`;

export const listUnsubHeaders = (unsub) => ({
  "List-Unsubscribe": `<${unsub}>, <mailto:${REPLY_TO}?subject=unsubscribe>`,
  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
});

export function page(title, body, status = 200) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title} | minesSwept</title>
<style>body{margin:0;font:17px/1.6 Georgia,serif;color:#ead7b4;background:#140e0a}.w{max-width:620px;margin:0 auto;padding:48px 22px}a{color:#e4b15a}button{min-height:44px;padding:0 16px;background:#e4b15a;color:#140e0a;border:0;font:600 13px ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;cursor:pointer}.m{font:12px/1.5 ui-monospace,Menlo,monospace;color:#b5a48a}</style></head>
<body><div class="w"><a href="/">minesSwept</a>${body}<p class="m">Telep IO LLC. ${ADDRESS}.</p></div></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}
