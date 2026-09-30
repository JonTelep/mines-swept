// Two real clients against `wrangler dev`, proving they share one persistent field
// and that hidden mine locations never leave the server.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const PORT = 8791;
const root = new URL("..", import.meta.url).pathname;

function start(persist) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "npx",
      [
        "wrangler",
        "dev",
        "--port",
        String(PORT),
        "--ip",
        "127.0.0.1",
        "--persist-to",
        persist,
        "--local",
        "--show-interactive-dev-session=false",
        "--log-level",
        "info",
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
      child.kill("SIGKILL");
      reject(new Error("wrangler did not become ready\n" + buf.slice(-4000)));
    }, 90000);
    const onData = (chunk) => {
      buf += chunk.toString();
      if (/Ready on|localhost:8791|127\.0\.0\.1:8791/.test(buf)) {
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
    const done = () => resolve();
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      done();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  });
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const inbox = [];
    const waiters = [];
    const timer = setTimeout(() => reject(new Error("socket open timeout")), 10000);
    ws.addEventListener("message", (ev) => {
      if (ev.data === "pong" || ev.data === "ping") return;
      const msg = JSON.parse(ev.data);
      if (waiters.length) waiters.shift()(msg);
      else inbox.push(msg);
    });
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve({
        ws,
        send(obj) {
          ws.send(JSON.stringify(obj));
        },
        next(ms = 5000) {
          if (inbox.length) return Promise.resolve(inbox.shift());
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error("timed out waiting for a message")), ms);
            waiters.push((msg) => {
              clearTimeout(t);
              res(msg);
            });
          });
        },
        async until(pred, ms = 6000) {
          const start = Date.now();
          while (Date.now() - start < ms) {
            const msg = await this.next(ms - (Date.now() - start));
            if (pred(msg)) return msg;
          }
          throw new Error("condition not met");
        },
      });
    });
    ws.addEventListener("error", () => reject(new Error("socket error")));
  });
}

function assertNoMineLeak(msg) {
  const blob = JSON.stringify(msg);
  assert.equal(blob.includes('"seed"'), false);
  assert.equal(blob.includes("isBomb"), false);
  assert.equal(blob.includes('"mine":'), false);
  for (const cell of msg.cells || []) {
    assert.ok(["n", "m", "f", "h"].includes(cell.k), cell.k);
  }
}

test("two clients see each other's moves, and the field survives a restart", async () => {
  const persist = await mkdtemp(join(tmpdir(), "minesswept-"));
  let child = await start(persist);
  try {
    const ada = await connect();
    ada.send({
      t: "hello",
      id: "player-ada",
      name: "Ada",
      v: { x0: -6, y0: -6, x1: 6, y1: 6 },
    });
    const welcomeAda = await ada.until((m) => m.t === "welcome");
    assert.equal(welcomeAda.you.name, "Ada");
    assertNoMineLeak(welcomeAda);

    const bea = await connect();
    bea.send({
      t: "hello",
      id: "player-bea",
      name: "Bea",
      v: { x0: -8, y0: -8, x1: 40, y1: 40 },
    });
    const welcomeBea = await bea.until((m) => m.t === "welcome");
    assert.ok(welcomeBea.stats.online >= 2);
    assertNoMineLeak(welcomeBea);

    ada.send({ t: "cursor", x: 2, y: 2 });
    const seenCursor = await bea.until((m) => m.t === "cursors" && m.p?.some((p) => p.name === "Ada"));
    assert.equal(seenCursor.p[0].x, 2);

    ada.send({ t: "flag", x: 30, y: 31 });
    const flagMsg = await bea.until((m) => m.t === "delta" && m.cells?.some((c) => c.x === 30 && c.y === 31 && c.k === "f"));
    assertNoMineLeak(flagMsg);
    assert.equal(flagMsg.cells.find((c) => c.x === 30).c.length > 0, true);

    ada.send({ t: "reveal", x: 0, y: 0 });
    const digMsg = await bea.until(
      (m) => m.t === "delta" && m.event && m.event.name === "Ada" && (m.event.type === "clear" || m.event.type === "boom"),
    );
    assertNoMineLeak(digMsg);
    if (digMsg.event.type === "boom") {
      assert.ok(digMsg.cells.some((c) => c.k === "m"));
    } else {
      assert.ok(digMsg.cells.some((c) => c.k === "n"));
      assert.ok(digMsg.cells.every((c) => c.k !== "m"));
    }
    const adaYou = await ada.until((m) => m.t === "you");
    assert.equal(typeof adaYou.score, "number");

    bea.send({ t: "flag", x: 4, y: 5 });
    const back = await ada.until((m) => m.t === "delta" && m.cells?.some((c) => c.x === 4 && c.y === 5 && c.k === "f"));
    assert.ok(back.cells);

    const stats = await fetch(`http://127.0.0.1:${PORT}/api/stats`);
    assert.equal(stats.status, 200);
    const body = await stats.json();
    assert.equal(typeof body.cleared, "number");
    assert.equal(JSON.stringify(body).includes("seed"), false);
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
      v: { x0: 28, y0: 28, x1: 34, y1: 34 },
    });
    const welcome = await cay.until((m) => m.t === "welcome");
    assert.ok(welcome.cells.some((c) => c.x === 30 && c.y === 31 && c.k === "f"));
    assertNoMineLeak(welcome);
    cay.ws.close();
  } finally {
    await stop(child);
    await rm(persist, { recursive: true, force: true });
  }
});
