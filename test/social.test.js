// Two clients: chat, the slur filter, a shared round-over, and history that survives restart.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GRACE_MS, INTERMISSION_MS } from "../src/round.js";
import { evasionCases } from "../src/slurs.js";

const PORT = 8793;
const root = new URL("..", import.meta.url).pathname;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function start(persist) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "npx",
      [
        "wrangler", "dev",
        "--port", String(PORT),
        "--ip", "127.0.0.1",
        "--persist-to", persist,
        "--local",
        "--show-interactive-dev-session=false",
        "--log-level", "info",
      ],
      {
        cwd: root,
        env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let buf = "";
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
      reject(new Error("wrangler did not become ready\n" + buf.slice(-4000)));
    }, 90000);
    const onData = (chunk) => {
      buf += chunk.toString();
      if (new RegExp(`127\\.0\\.0\\.1:${PORT}|localhost:${PORT}|Ready on`).test(buf)) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`wrangler exited ${code}\n` + buf.slice(-4000)));
    });
  });
}

function stop(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode != null) return resolve();
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  });
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const inbox = [];
    const waiters = [];
    const timer = setTimeout(() => reject(new Error("socket open timeout")), 10000);
    const sock = {
      ws,
      closed: 0,
      send(obj) { ws.send(JSON.stringify(obj)); },
    };
    ws.addEventListener("message", (ev) => {
      if (ev.data === "pong" || ev.data === "ping") return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (waiters.length) waiters.shift()(msg);
      else inbox.push(msg);
    });
    ws.addEventListener("close", (ev) => {
      sock.closed = ev.code || 1006;
    });
    sock.next = (ms = 5000) => {
      if (inbox.length) return Promise.resolve(inbox.shift());
      return new Promise((res, rej) => {
        const t = setTimeout(() => {
          rej(new Error(`timed out waiting for a message (ready=${sock.ws.readyState} closed=${sock.closed})`));
        }, ms);
        waiters.push((msg) => {
          clearTimeout(t);
          res(msg);
        });
      });
    };
    sock.until = async (pred, ms = 8000) => {
      const start = Date.now();
      while (Date.now() - start < ms) {
        const msg = await sock.next(ms - (Date.now() - start));
        if (pred(msg)) return msg;
      }
      throw new Error("condition not met");
    };
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(sock);
    });
    ws.addEventListener("error", () => reject(new Error("socket error")));
  });
}

async function hold(socks, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (const sock of socks) {
      if (sock.ws.readyState === WebSocket.OPEN) {
        sock.send({ t: "view", x0: -8, y0: -8, x1: 8, y1: 8 });
      }
    }
    await sleep(Math.min(1500, Math.max(0, end - Date.now())));
  }
  for (const sock of socks) {
    if (sock.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`socket closed during wait (${sock.closed})`);
    }
  }
}

function hello(id, name) {
  return {
    t: "hello",
    id,
    name,
    v: { x0: -20, y0: -20, x1: 20, y1: 20 },
  };
}

async function reveal(sock, x, y) {
  sock.send({ t: "reveal", x, y });
  const msgs = [];
  const start = Date.now();
  while (Date.now() - start < 4000) {
    const msg = await sock.next(4000 - (Date.now() - start));
    msgs.push(msg);
    if (msg.t === "over" || msg.t === "no") return msgs;
    if (msg.t === "you") {
      try { msgs.push(await sock.next(300)); } catch { /* no follow-up */ }
      return msgs;
    }
  }
  return msgs;
}

test("chat filter, shared round-over, reset, and history", async () => {
  const persist = await mkdtemp(join(tmpdir(), "minesswept-social-"));
  let child = await start(persist);
  try {
    const ada = await connect();
    const bea = await connect();
    ada.send(hello("player-ada", "Ada"));
    const welcome = await ada.until((m) => m.t === "welcome");
    assert.equal(welcome.stats.round, 1);
    assert.equal(welcome.stats.phase, "play");
    bea.send(hello("player-bea", "Bea"));
    await bea.until((m) => m.t === "welcome");

    ada.send({ t: "chat", text: "hi <b>Bea</b> https://example.com" });
    const chat = await bea.until((m) => m.t === "chat" && m.msg?.body?.includes("Bea"));
    assert.equal(chat.msg.body.includes("<"), false);
    assert.equal(chat.msg.body.includes("https://example.com"), true);
    assert.equal(chat.msg.kind, "user");

    ada.send({ t: "chat", text: "too soon" });
    const limited = await ada.until((m) => m.t === "no");
    assert.equal(limited.reason, "chat");

    await sleep(CHAT_WAIT);
    const slur = evasionCases()[0].spaced;
    ada.send({ t: "chat", text: slur });
    const blocked = await ada.until((m) => m.t === "no");
    assert.equal(blocked.reason, "blocked");
    ada.send({ t: "name", name: slur });
    const renamed = await ada.until((m) => m.t === "no" || m.t === "you");
    assert.equal(renamed.t, "no");
    assert.equal(renamed.reason, "name");

    const quiet = [];
    const ear = Date.now();
    while (Date.now() - ear < 400) {
      try { quiet.push(await bea.next(400 - (Date.now() - ear))); } catch { break; }
    }
    assert.equal(quiet.some((m) => m.t === "chat" && m.msg?.body === slur), false);

    const wait = welcome.stats.startedAt + GRACE_MS + 500 - Date.now();
    if (wait > 0) await hold([ada, bea], wait);

    ada.send({ t: "flag", x: 40, y: 40 });
    await ada.until((m) => m.t === "delta" && m.cells?.some((c) => c.k === "f"));

    const revealed = new Set();
    const queue = [[0, 0]];
    let over = null;
    let guard = 0;
    while (!over && queue.length && guard++ < 80) {
      const [x, y] = queue.shift();
      const key = `${x},${y}`;
      if (revealed.has(key)) continue;
      const msgs = await reveal(ada, x, y);
      if (msgs.some((m) => m.t === "no" && m.reason === "rate")) {
        queue.unshift([x, y]);
        await sleep(400);
        continue;
      }
      revealed.add(key);
      over = msgs.find((m) => m.t === "over") || null;
      for (const msg of msgs) {
        for (const cell of msg.cells || []) {
          if (cell.k === "h") continue;
          revealed.add(`${cell.x},${cell.y}`);
          if (cell.k === "n" && cell.n > 0) {
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                if (!dx && !dy) continue;
                const nk = `${cell.x + dx},${cell.y + dy}`;
                if (!revealed.has(nk)) queue.push([cell.x + dx, cell.y + dy]);
              }
            }
          }
        }
      }
      if (!over) await sleep(180);
    }
    assert.ok(over, "expected a mine to end the round");
    assert.match(over.line, /Ada blew it for/);
    assert.equal(over.round, 1);
    assert.ok(over.cells?.some((c) => c.k === "m"));
    assert.equal(JSON.stringify(over).includes('"seed"'), false);

    const beaOver = await bea.until((m) => m.t === "over");
    assert.equal(beaOver.line, over.line);
    const shame = await bea.until((m) => m.t === "chat" && m.msg?.kind === "system" && m.msg.body.includes("blew it"));
    assert.match(shame.msg.body, /Round #1/);

    const left = Math.max(0, over.nextAt - Date.now());
    await hold([ada, bea], left + 400);
    ada.send({ t: "tick" });
    const next = await ada.until((m) => m.t === "round", 8000);
    assert.equal(next.round, 2);
    assert.equal(next.stats.phase, "play");
    assert.ok(next.history.some((row) => row.n === 1 && row.name === "Ada"));
    const beaNext = await bea.until((m) => m.t === "round", 8000);
    assert.equal(beaNext.round, 2);

    ada.ws.close();
    bea.ws.close();
  } finally {
    await stop(child);
  }

  child = await start(persist);
  try {
    const cay = await connect();
    cay.send({
      t: "hello",
      id: "player-cay",
      name: "Cay",
      v: { x0: 36, y0: 36, x1: 44, y1: 44 },
    });
    const again = await cay.until((m) => m.t === "welcome");
    assert.equal(again.stats.round, 2);
    assert.ok(again.history.some((row) => row.name === "Ada" && row.n === 1));
    assert.equal(again.cells.some((c) => c.x === 40 && c.y === 40), false);
    assert.ok(again.chat.some((m) => m.kind === "system" && m.body.includes("blew it")));
    cay.ws.close();
  } finally {
    await stop(child);
    await rm(persist, { recursive: true, force: true });
  }
});

const CHAT_WAIT = 2100;

void INTERMISSION_MS;
