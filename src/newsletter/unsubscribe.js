// GET /api/unsubscribe?t=<signed token> shows a page.
// POST performs the one-click unsubscribe (List-Unsubscribe-Post).
// A valid POST returns 200 and sets the contact to unsubscribed.
// It never sends email.

import { STATUS_KEY, UNSUBSCRIBED, page, resend, verifyToken } from "./mail.js";

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
import { checkSyntax } from "./validate.js";
import { allow, clientIp } from "./limit.js";

const WINDOW_MS = 10 * 60 * 1000;
const LIMIT = 30;

async function tokenEmail(request, env) {
  const url = new URL(request.url);
  let token = url.searchParams.get("t");
  if (!token && request.method === "POST") {
    try {
      const ct = request.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const data = await request.clone().json();
        token = data && data.t;
      } else if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
        const data = await request.clone().formData();
        token = data.get("t");
      }
    } catch {
      token = null;
    }
  }
  if (!env || !env.NEWSLETTER_SECRET) return null;
  const email = await verifyToken(env.NEWSLETTER_SECRET, "unsub", token, 0);
  const syntax = email && checkSyntax(email);
  return syntax ? syntax.email : null;
}

function limited(request) {
  return !allow(`unsub:${clientIp(request)}`, LIMIT, WINDOW_MS);
}

export async function handleUnsubscribe(request, env, fetchFn = fetch) {
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method not allowed.", {
      status: 405,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }

  if (limited(request)) {
    if (request.method === "POST") {
      return new Response("Too many tries.", {
        status: 429,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }
    return page("Slow down", "<h1>Too many tries</h1><p>Please wait and try again.</p>", 429);
  }

  const email = await tokenEmail(request, env);
  if (!email) {
    const body = `<h1>That link did not work</h1><p>Reply to any minesSwept note with "unsubscribe" and we will remove you by hand.</p>`;
    if (request.method === "POST") {
      return new Response("Error", {
        status: 400,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }
    return page("Unsubscribe", body, 400);
  }

  if (request.method === "GET") {
    const action = new URL(request.url).pathname;
    const token = new URL(request.url).searchParams.get("t") || "";
    return page(
      "Unsubscribe",
      `<h1>Unsubscribe</h1><p>This removes ${escapeHtml(email)} from new boards and events.</p>
<form method="post" action="${action}?t=${encodeURIComponent(token)}"><button type="submit">Unsubscribe</button></form>`,
      200,
    );
  }

  if (!env.RESEND_API_KEY) {
    return new Response("Error", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const r = await resend(env.RESEND_API_KEY, fetchFn)("PATCH", `/contacts/${encodeURIComponent(email)}`, {
    unsubscribed: true,
    properties: { [STATUS_KEY]: UNSUBSCRIBED },
  });
  if (!r.ok && r.status !== 404) {
    return new Response("Error", {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const accept = request.headers.get("accept") || "";
  if (accept.includes("text/html")) {
    return page(
      "Unsubscribed",
      "<h1>You are unsubscribed</h1><p>This address will not get new boards and events.</p>",
      200,
    );
  }
  return new Response("Unsubscribed", {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
