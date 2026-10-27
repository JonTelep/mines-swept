// POST /api/subscribe
// Single opt-in. A valid submitted email is consent: the contact is stored
// active (unsubscribed false, minesswept_status active) in the Resend segment.
// Syntax failures, disposable domains, and domains with no MX are dropped
// quietly. Unsubscribed contacts are never written back to active.
// This route never calls the Resend email API.
// Missing RESEND_API_KEY, NEWSLETTER_SECRET, or RESEND_SEGMENT_ID fails closed.
// dryRun is rejected. It is not reported as success.

import { ACTIVE, STATUS_KEY, isActive, isUnsubscribed, page, resend, segmentId } from "./mail.js";
import { allow, clientIp } from "./limit.js";
import { validateEmail } from "./validate.js";

const PLACEMENTS = ["board", "stats", "other"];
const WINDOW_MS = 10 * 60 * 1000;
const LIMIT = 5;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function wantsHtml(request) {
  return (request.headers.get("accept") || "").includes("text/html");
}

function respond(request, payload, status, html) {
  if (wantsHtml(request)) return page(html.title, html.body, status);
  return json(payload, status);
}

async function readBody(request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await request.json();
  return Object.fromEntries(await request.formData());
}

function quiet(request) {
  return respond(
    request,
    { ok: true },
    200,
    {
      title: "Signed up",
      body: "<h1>You're on the list</h1><p>New boards and events. Nothing was sent just now.</p>",
    },
  );
}

export async function handleSubscribe(request, env, fetchFn = fetch) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed." }, 405);
  }

  let data;
  try {
    data = await readBody(request);
  } catch {
    return json({ ok: false, error: "Invalid request." }, 400);
  }

  const ip = clientIp(request);
  if (!allow(`sub:${ip}`, LIMIT, WINDOW_MS)) {
    return respond(
      request,
      { ok: false, error: "Too many tries. Please wait and try again." },
      429,
      { title: "Slow down", body: "<h1>Too many tries</h1><p>Please wait and try again.</p>" },
    );
  }

  if (data.website) return quiet(request);

  if (data.dryRun && data.dryRun !== "false" && data.dryRun !== false) {
    return respond(
      request,
      { ok: false, error: "Dry run is not available." },
      400,
      { title: "Dry run", body: "<h1>Dry run is not available</h1><p>Nothing was saved.</p>" },
    );
  }

  const segment = segmentId(env);
  if (!env || !env.RESEND_API_KEY || !env.NEWSLETTER_SECRET || !segment) {
    return respond(
      request,
      { ok: false, error: "Could not subscribe right now. Please try again later." },
      503,
      {
        title: "Try again",
        body: "<h1>Signup is not available right now</h1><p>Please try again later. Nothing was saved.</p>",
      },
    );
  }

  const raw = String(data.email || "").trim().toLowerCase();
  if (!raw || !raw.includes("@")) {
    return respond(
      request,
      { ok: false, error: "Please enter a valid email address." },
      400,
      { title: "Email", body: "<h1>Please enter a valid email address</h1>" },
    );
  }

  const v = await validateEmail(raw, fetchFn);
  if (!v.ok) return quiet(request);
  if (v.reason === "mx-unknown") {
    return respond(
      request,
      { ok: false, error: "Could not check that address. Please try again later." },
      503,
      {
        title: "Try again",
        body: "<h1>Could not check that address</h1><p>Please try again later. Nothing was saved.</p>",
      },
    );
  }

  const email = v.email;
  const placement = PLACEMENTS.includes(String(data.placement)) ? String(data.placement) : "other";
  const api = resend(env.RESEND_API_KEY, fetchFn);
  const path = `/contacts/${encodeURIComponent(email)}`;
  const failed = () =>
    respond(
      request,
      { ok: false, error: "Could not subscribe right now. Please try again later." },
      502,
      { title: "Try again", body: "<h1>Something went wrong</h1><p>Please try again later.</p>" },
    );
  const left = () =>
    respond(
      request,
      { ok: true, status: "unsubscribed" },
      200,
      {
        title: "Unsubscribed",
        body: "<h1>That address is unsubscribed</h1><p>It was not added again.</p>",
      },
    );

  const got = await api("GET", path);
  if (!got.ok && got.status !== 404) return failed();

  let contact = got.ok ? got.data : null;
  const already = !!(contact && isActive(contact));

  if (contact && isUnsubscribed(contact)) return left();

  if (!contact) {
    const created = await api("POST", "/contacts", {
      email,
      unsubscribed: false,
      properties: { [STATUS_KEY]: ACTIVE, signup_source: placement },
      segments: [{ id: segment }],
    });
    if (created.status === 409) {
      const again = await api("GET", path);
      if (!again.ok) return failed();
      contact = again.data;
      if (isUnsubscribed(contact)) return left();
    } else if (!created.ok) {
      return failed();
    }
  }

  if (contact && !isActive(contact)) {
    const patched = await api("PATCH", path, {
      unsubscribed: false,
      properties: { [STATUS_KEY]: ACTIVE },
    });
    if (!patched.ok) return failed();
  }

  const added = await api("POST", `${path}/segments/${encodeURIComponent(segment)}`);
  if (!added.ok && added.status !== 409) return failed();

  if (already) {
    return respond(
      request,
      { ok: true, already: true },
      200,
      { title: "Signed up", body: "<h1>You're already on the list</h1>" },
    );
  }
  return quiet(request);
}
