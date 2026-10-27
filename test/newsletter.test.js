import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import worker from "../src/index.js";
import { ADDRESS, emailFooterHtml, emailFooterText, listUnsubHeaders, signToken, unsubUrl } from "../src/newsletter/mail.js";
import { resetLimits } from "../src/newsletter/limit.js";
import { validateEmail } from "../src/newsletter/validate.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const SECRET = "test-newsletter-secret";
const SEGMENT = "seg_mines_boards";
const KEY = "re_test_key";
const DASH = /[\u2013\u2014]/;

function env(extra = {}) {
  return { RESEND_API_KEY: KEY, NEWSLETTER_SECRET: SECRET, RESEND_SEGMENT_ID: SEGMENT, ...extra };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch(store) {
  const calls = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    calls.push({ url: u, method, body: init.body || null, headers: init.headers || {} });
    if (u.includes("/emails")) {
      store.emails.push(init.body ? JSON.parse(init.body) : null);
      return jsonResponse({ id: "email_should_not_send" });
    }
    if (u.includes("cloudflare-dns.com")) {
      const parsed = new URL(u);
      const name = parsed.searchParams.get("name");
      const type = parsed.searchParams.get("type");
      if (name === "down.test") throw new Error("doh down");
      if (name === "gmail.com" && type === "MX") {
        return jsonResponse({ Status: 0, Answer: [{ type: 15, data: "10 alt1.gmail-smtp-in.l.google.com." }] });
      }
      if (name === "nomail.test" && type === "MX") return jsonResponse({ Status: 0, Answer: [] });
      if (name === "nomail.test" && type === "A") return jsonResponse({ Status: 0, Answer: [] });
      return jsonResponse({ Status: 3, Answer: [] });
    }
    if (u.startsWith("https://api.resend.com")) return resendRoute(store, u, method, init);
    throw new Error("unexpected fetch " + method + " " + u);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = prev;
    },
  };
}

function resendRoute(store, url, method, init) {
  const path = new URL(url).pathname;
  const contactMatch = path.match(/^\/contacts\/([^/]+)$/);
  if (contactMatch && method === "GET") {
    const email = decodeURIComponent(contactMatch[1]);
    const contact = store.contacts.get(email);
    if (!contact) return jsonResponse({ message: "not found" }, 404);
    return jsonResponse(contact);
  }
  if (contactMatch && method === "PATCH") {
    const email = decodeURIComponent(contactMatch[1]);
    const contact = store.contacts.get(email);
    if (!contact) return jsonResponse({ message: "not found" }, 404);
    const body = JSON.parse(init.body);
    store.patches.push({ email, body });
    if (typeof body.unsubscribed === "boolean") contact.unsubscribed = body.unsubscribed;
    contact.properties = contact.properties || {};
    for (const [k, v] of Object.entries(body.properties || {})) contact.properties[k] = { value: v };
    return jsonResponse(contact);
  }
  if (path === "/contacts" && method === "POST") {
    const body = JSON.parse(init.body);
    if (store.contacts.has(body.email)) return jsonResponse({ message: "exists" }, 409);
    const contact = {
      id: "con_" + (store.contacts.size + 1),
      email: body.email,
      unsubscribed: body.unsubscribed,
      properties: {},
    };
    for (const [k, v] of Object.entries(body.properties || {})) contact.properties[k] = { value: v };
    store.contacts.set(body.email, contact);
    if (store.honorCreateSegments !== false) {
      for (const seg of body.segments || []) store.segments.add(`${body.email}:${seg.id}`);
    }
    store.creates.push(body);
    return jsonResponse(contact);
  }
  const seg = path.match(/^\/contacts\/([^/]+)\/segments\/([^/]+)$/);
  if (seg && method === "POST") {
    if (store.segmentStatus) return jsonResponse({ message: "segment failed" }, store.segmentStatus);
    const email = decodeURIComponent(seg[1]);
    const id = decodeURIComponent(seg[2]);
    if (!store.contacts.has(email)) return jsonResponse({ message: "not found" }, 404);
    const key = `${email}:${id}`;
    if (store.segments.has(key)) return jsonResponse({ message: "already" }, 409);
    store.segments.add(key);
    return jsonResponse({ id });
  }
  return jsonResponse({ message: "no route " + method + " " + path }, 500);
}

function freshStore() {
  return {
    contacts: new Map(),
    segments: new Set(),
    patches: [],
    creates: [],
    emails: [],
    segmentStatus: 0,
    honorCreateSegments: true,
  };
}

async function postSubscribe(email, ip, options = {}) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    "CF-Connecting-IP": ip,
    ...(options.headers || {}),
  };
  const payload = { email, placement: options.placement || "board", ...(options.body || {}) };
  return worker.fetch(
    new Request("https://minesswept.com/api/subscribe", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }),
    options.env || env(),
  );
}

test("pages offer new boards and events with the postal footer and no dashes", () => {
  const pages = [
    ["public/index.html", "board"],
    ["public/stats/index.html", "stats"],
  ];
  for (const [file, placement] of pages) {
    const html = readFileSync(join(root, file), "utf8");
    const block = html.match(/<form class="signup"[\s\S]*?<\/form>/);
    assert.ok(block, file);
    assert.equal(DASH.test(block[0]), false, file);
    assert.match(block[0], /New boards and events/);
    assert.match(block[0], /PO Box 187, Valley City, OH 44280/);
    assert.match(block[0], new RegExp(`name="placement" value="${placement}"`));
    assert.match(block[0], /name="website"/);
    assert.match(block[0], /sends no email/);
    const footer = html.match(/<footer class="other-sites">[\s\S]*?<\/footer>/);
    assert.ok(footer, file);
    assert.equal(footer[0].includes("signup"), false, file);
  }
  const css = readFileSync(join(root, "public/style.css"), "utf8");
  assert.match(css, /#mini[\s\S]*pointer-events:\s*auto/);
  assert.match(css, /\.tools button[\s\S]*pointer-events:\s*auto/);
  const client = readFileSync(join(root, "public/client.js"), "utf8");
  assert.match(client, /\.signup/);
});

test("new newsletter source has no em or en dashes", () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(join(root, "src/newsletter"));
  files.push(join(root, "public/signup.js"), join(root, "test/newsletter.test.js"));
  for (const file of files) assert.equal(DASH.test(readFileSync(file, "utf8")), false, file);
});

test("validation covers syntax, disposable domains, and MX", async () => {
  const store = freshStore();
  const net = installFetch(store);
  try {
    assert.equal((await validateEmail("not-an-email")).ok, false);
    assert.equal((await validateEmail("a..b@gmail.com")).reason, "syntax");
    assert.equal((await validateEmail("person@mail.mailinator.com")).reason, "disposable");
    assert.equal((await validateEmail("person@gmail.com")).reason, "mx");
    assert.equal((await validateEmail("person@nomail.test")).reason, "no-mx");
    assert.equal((await validateEmail("person@down.test")).reason, "mx-unknown");
    assert.equal(store.contacts.size, 0);
  } finally {
    net.restore();
  }
});

test("signup stores an active contact and sends no email", async () => {
  resetLimits();
  const store = freshStore();
  const net = installFetch(store);
  try {
    const res = await postSubscribe("Player@gmail.com", "203.0.113.10", { env: env({ WELCOME_EMAIL: "1" }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.dryRun, undefined);
    const contact = store.contacts.get("player@gmail.com");
    assert.equal(contact.unsubscribed, false);
    assert.equal(contact.properties.minesswept_status.value, "active");
    assert.equal(contact.properties.signup_source.value, "board");
    assert.equal(store.segments.has("player@gmail.com:" + SEGMENT), true);
    assert.equal(store.emails.length, 0);
    assert.equal(net.calls.some((c) => c.url.includes("/emails")), false);
    const again = await postSubscribe("player@gmail.com", "203.0.113.11");
    assert.equal(again.status, 200);
    assert.equal((await again.json()).already, true);
    assert.equal(store.creates.length, 1);
  } finally {
    net.restore();
  }
});

test("missing segment id fails closed and does not write a contact", async () => {
  resetLimits();
  const store = freshStore();
  const net = installFetch(store);
  try {
    for (const id of [undefined, "", "   "]) {
      const res = await postSubscribe("player@gmail.com", "203.0.113.20", {
        env: { RESEND_API_KEY: KEY, NEWSLETTER_SECRET: SECRET, RESEND_SEGMENT_ID: id },
      });
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.ok, false);
    }
    const noKey = await postSubscribe("player@gmail.com", "203.0.113.21", {
      env: { NEWSLETTER_SECRET: SECRET, RESEND_SEGMENT_ID: SEGMENT },
    });
    assert.equal(noKey.status, 503);
    assert.equal((await noKey.json()).ok, false);
    assert.equal(store.contacts.size, 0);
    assert.equal(net.calls.some((c) => c.url.includes("api.resend.com")), false);
  } finally {
    net.restore();
  }
});

test("dry run is not a success and does not write a contact", async () => {
  resetLimits();
  const store = freshStore();
  const net = installFetch(store);
  try {
    const res = await postSubscribe("player@gmail.com", "203.0.113.30", { body: { dryRun: true } });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.dryRun, undefined);
    assert.equal(store.contacts.size, 0);
    assert.equal(net.calls.some((c) => c.url.includes("api.resend.com")), false);
  } finally {
    net.restore();
  }
});

test("invalid, disposable, and no-MX addresses are not stored", async () => {
  resetLimits();
  const store = freshStore();
  const net = installFetch(store);
  try {
    const bad = await postSubscribe("nope", "203.0.113.40");
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).ok, false);
    for (const email of ["person@mailinator.com", "person@nomail.test", "a..b@gmail.com"]) {
      const res = await postSubscribe(email, "203.0.113.41");
      assert.equal(res.status, 200);
      assert.equal((await res.json()).ok, true);
    }
    const down = await postSubscribe("person@down.test", "203.0.113.42");
    assert.equal(down.status, 503);
    assert.equal((await down.json()).ok, false);
    assert.equal(store.contacts.size, 0);
    assert.equal(net.calls.some((c) => c.url.includes("api.resend.com")), false);
  } finally {
    net.restore();
  }
});

test("rate limit rejects the sixth subscribe from one address", async () => {
  resetLimits();
  const store = freshStore();
  const net = installFetch(store);
  try {
    for (let i = 0; i < 5; i++) {
      const res = await postSubscribe(`player${i}@gmail.com`, "203.0.113.50");
      assert.equal(res.status, 200, String(i));
    }
    const blocked = await postSubscribe("player5@gmail.com", "203.0.113.50");
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).ok, false);
    assert.equal(store.contacts.has("player5@gmail.com"), false);
  } finally {
    net.restore();
  }
});

test("one-click POST returns 200 and the contact flips to unsubscribed", async () => {
  resetLimits();
  const store = freshStore();
  store.contacts.set("player@gmail.com", {
    id: "con_1",
    email: "player@gmail.com",
    unsubscribed: false,
    properties: { minesswept_status: { value: "active" } },
  });
  store.segments.add("player@gmail.com:" + SEGMENT);
  const net = installFetch(store);
  try {
    const token = await signToken(SECRET, "unsub", "player@gmail.com", 0);
    const url = `https://minesswept.com/api/unsubscribe?t=${encodeURIComponent(token)}`;
    const peek = await worker.fetch(new Request(url, { headers: { "CF-Connecting-IP": "203.0.113.60" } }), env());
    assert.equal(peek.status, 200);
    const html = await peek.text();
    assert.match(html, /PO Box 187, Valley City, OH 44280/);
    assert.match(html, /Unsubscribe/);
    assert.equal(store.contacts.get("player@gmail.com").unsubscribed, false);
    assert.equal(store.patches.length, 0);

    const res = await worker.fetch(
      new Request(url, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "CF-Connecting-IP": "203.0.113.60",
        },
        body: "List-Unsubscribe=One-Click",
      }),
      env(),
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "Unsubscribed");
    const contact = store.contacts.get("player@gmail.com");
    assert.equal(contact.unsubscribed, true);
    assert.equal(contact.properties.minesswept_status.value, "unsubscribed");
    assert.equal(store.patches.length, 1);
    assert.deepEqual(store.patches[0].body, {
      unsubscribed: true,
      properties: { minesswept_status: "unsubscribed" },
    });
    assert.equal(store.emails.length, 0);

    const again = await postSubscribe("player@gmail.com", "203.0.113.61");
    assert.equal(again.status, 200);
    assert.equal((await again.json()).status, "unsubscribed");
    assert.equal(contact.unsubscribed, true);
    assert.equal(contact.properties.minesswept_status.value, "unsubscribed");
    assert.equal(store.patches.length, 1);
    assert.equal(store.creates.length, 0);

    const tampered = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
    const bad = await worker.fetch(
      new Request(`https://minesswept.com/api/unsubscribe?t=${encodeURIComponent(tampered)}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "203.0.113.62" },
        body: "List-Unsubscribe=One-Click",
      }),
      env(),
    );
    assert.equal(bad.status, 400);
    assert.equal(contact.unsubscribed, true);
  } finally {
    net.restore();
  }
});

test("status unsubscribed without the global flag is not signed up again", async () => {
  resetLimits();
  const store = freshStore();
  store.contacts.set("player@gmail.com", {
    id: "con_2",
    email: "player@gmail.com",
    unsubscribed: false,
    properties: { minesswept_status: { value: "unsubscribed" } },
  });
  const net = installFetch(store);
  try {
    const res = await postSubscribe("player@gmail.com", "203.0.113.70");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "unsubscribed");
    assert.equal(store.patches.length, 0);
    assert.equal(store.contacts.get("player@gmail.com").properties.minesswept_status.value, "unsubscribed");
  } finally {
    net.restore();
  }
});

test("a failed segment add is not reported as success", async () => {
  resetLimits();
  const store = freshStore();
  store.segmentStatus = 500;
  store.honorCreateSegments = false;
  const net = installFetch(store);
  try {
    const res = await postSubscribe("player@gmail.com", "203.0.113.80");
    assert.equal(res.status, 502);
    assert.equal((await res.json()).ok, false);
    assert.equal(store.segments.has("player@gmail.com:" + SEGMENT), false);
  } finally {
    net.restore();
  }
});

test("footer helpers carry the postal address and the one-click header", async () => {
  const url = await unsubUrl(SECRET, "player@gmail.com");
  assert.match(url, /^https:\/\/minesswept\.com\/api\/unsubscribe\?t=/);
  const headers = listUnsubHeaders(url);
  assert.match(headers["List-Unsubscribe"], new RegExp(`<${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>`));
  assert.equal(headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.match(emailFooterHtml(url), new RegExp(ADDRESS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(emailFooterText(url), /PO Box 187, Valley City, OH 44280/);
  assert.match(emailFooterHtml(url), new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("honeypot and a missing board binding do not crash or store a contact", async () => {
  resetLimits();
  const store = freshStore();
  const net = installFetch(store);
  try {
    const form = new FormData();
    form.set("email", "player@gmail.com");
    form.set("website", "https://spam.example");
    form.set("placement", "board");
    const bot = await worker.fetch(
      new Request("https://minesswept.com/api/subscribe", {
        method: "POST",
        headers: { accept: "application/json", "CF-Connecting-IP": "203.0.113.90" },
        body: form,
      }),
      env(),
    );
    assert.equal(bot.status, 200);
    assert.equal((await bot.json()).ok, true);
    assert.equal(store.contacts.size, 0);
    const get = await worker.fetch(new Request("https://minesswept.com/api/subscribe"), {});
    assert.equal(get.status, 405);
  } finally {
    net.restore();
  }
});
