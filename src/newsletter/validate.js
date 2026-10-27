// Signup validity check: syntax, disposable-domain blocklist, then MX via DNS-over-HTTPS.
import { DISPOSABLE } from "./disposable.js";

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,})$/;
const ALWAYS_OK = new Set(["resend.dev"]);

export function checkSyntax(email) {
  const e = String(email || "").trim().toLowerCase();
  if (e.length > 254) return null;
  const m = e.match(EMAIL_RE);
  if (!m || e.split("@")[0].length > 64 || e.includes("..") || e.startsWith(".") || e.split("@")[0].endsWith(".")) return null;
  return { email: e, domain: m[1] };
}

export function isDisposable(domain) {
  const parts = domain.split(".");
  for (let i = 0; i < parts.length - 1; i++) if (DISPOSABLE.has(parts.slice(i).join("."))) return true;
  return false;
}

// true = has MX (or an A record when there is no MX and it is not a null MX).
// false = no mail host. null = lookup failed.
export async function hasMx(domain, fetchFn = fetch) {
  const q = async (type) => {
    const r = await fetchFn(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`, {
      headers: { accept: "application/dns-json" },
    });
    if (!r.ok) throw new Error("doh " + r.status);
    return r.json();
  };
  try {
    const mx = await q("MX");
    if (mx.Status === 3) return false;
    const ans = (mx.Answer || []).filter((a) => a.type === 15);
    if (ans.length) return !ans.every((a) => /^0\s+\.?$/.test(String(a.data).trim()));
    const a = await q("A");
    return (a.Answer || []).some((x) => x.type === 1);
  } catch {
    return null;
  }
}

// { ok, email, reason }
export async function validateEmail(email, fetchFn = fetch) {
  const s = checkSyntax(email);
  if (!s) return { ok: false, email: String(email || ""), reason: "syntax" };
  if (ALWAYS_OK.has(s.domain)) return { ok: true, email: s.email, reason: "test-domain" };
  if (isDisposable(s.domain)) return { ok: false, email: s.email, reason: "disposable" };
  const mx = await hasMx(s.domain, fetchFn);
  if (mx === false) return { ok: false, email: s.email, reason: "no-mx" };
  // mx-unknown means the lookup failed. Callers must not treat that as a pass.
  return { ok: true, email: s.email, reason: mx === null ? "mx-unknown" : "mx" };
}
