// One Durable Object is the whole field: rules, persistence, and presence.
// Hibernating WebSockets keep it asleep between digs. Mines are computed,
// never stored, and never sent unless a player has already detonated them.

import {
  CHUNK,
  WORLD,
  attemptDig,
  attemptFlag,
  deterministicMine,
  inBounds,
  key,
} from "./game.js";
import { cleanName, colorFromId, nameFromId, validPlayerId } from "./names.js";
import { renderShareCard } from "./png.js";
import { checkChatRate, CHAT_KEEP, prepareChat } from "./chat.js";
import { containsSlur } from "./slurs.js";
import { INTERMISSION_MS, minesAround, shameLine, spareReason } from "./round.js";

const MAX_SOCKETS = 500;
const MAX_PER_IP = 8;
const VIEW_MAX = 80;
const CURSOR_MS = 700;

function txn(ctx, fn) {
  if (typeof ctx.storage.transactionSync === "function") ctx.storage.transactionSync(fn);
  else fn();
}

export class Board {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.overrides = new Map();
    this.seed = 1;
    this.feed = [];
    this.runtime = new Map();
    if (typeof ctx.setWebSocketAutoResponse === "function") {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    }
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      this.loadCore();
    });
  }

  sql() {
    return this.ctx.storage.sql;
  }

  migrate() {
    const sql = this.sql();
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS cells (
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      kind INTEGER NOT NULL,
      n INTEGER NOT NULL DEFAULT 0,
      color TEXT,
      PRIMARY KEY (x, y)
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      score INTEGER NOT NULL DEFAULT 0,
      clears INTEGER NOT NULL DEFAULT 0,
      booms INTEGER NOT NULL DEFAULT 0,
      cool INTEGER NOT NULL DEFAULT 0,
      updated INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS overrides (
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      mine INTEGER NOT NULL,
      PRIMARY KEY (x, y)
    )`);
    sql.exec(`CREATE INDEX IF NOT EXISTS players_score ON players(score)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS rounds (
      n INTEGER PRIMARY KEY,
      by_id TEXT,
      by_name TEXT,
      by_color TEXT,
      started INTEGER NOT NULL,
      ended INTEGER NOT NULL,
      cleared INTEGER NOT NULL,
      online INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS chat (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      name TEXT,
      color TEXT,
      body TEXT NOT NULL,
      kind TEXT NOT NULL
    )`);
  }

  loadCore() {
    const sql = this.sql();
    let seed = this.metaGet("seed");
    if (!seed) {
      const buf = new Uint32Array(1);
      crypto.getRandomValues(buf);
      seed = String((buf[0] || 1) >>> 0);
      this.metaSet("seed", seed);
      this.metaSet("cleared", "0");
      this.metaSet("booms", "0");
      this.metaSet("flags", "0");
      this.metaSet("born", String(Date.now()));
      this.metaSet("feed", "[]");
    }
    this.seed = Number(seed) >>> 0;
    this.round = Number(this.metaGet("round")) || 0;
    this.startedAt = Number(this.metaGet("started")) || Date.now();
    this.phase = this.metaGet("phase") || "play";
    this.shield = this.metaGet("shield") || "";
    this.bestMs = Number(this.metaGet("best_ms")) || 0;
    this.bestRound = Number(this.metaGet("best_round")) || 0;
    this.bestName = this.metaGet("best_name") || "";
    this.nextAt = Number(this.metaGet("nextAt")) || 0;
    try {
      this.over = JSON.parse(this.metaGet("over") || "null");
    } catch {
      this.over = null;
    }
    if (!this.round) {
      this.round = 1;
      this.phase = "play";
      this.startedAt = Date.now();
      this.metaSet("round", "1");
      this.metaSet("phase", "play");
      this.metaSet("started", String(this.startedAt));
      this.metaSet("roundCleared", "0");
      this.metaSet("shield", "");
    }
    this.overrides = new Map();
    for (const row of sql.exec(`SELECT x, y, mine FROM overrides`).toArray()) {
      this.overrides.set(key(row.x, row.y), row.mine ? 1 : 0);
    }
    try {
      this.feed = JSON.parse(this.metaGet("feed") || "[]");
      if (!Array.isArray(this.feed)) this.feed = [];
    } catch {
      this.feed = [];
    }
    if (this.phase === "over" && this.nextAt && Date.now() >= this.nextAt) {
      this.beginRound();
    } else if (this.phase === "over" && this.nextAt) {
      this.armAlarm(this.nextAt);
    }
  }

  metaGet(k) {
    const row = this.sql().exec(`SELECT v FROM meta WHERE k = ?`, k).toArray()[0];
    return row ? row.v : null;
  }

  metaSet(k, v) {
    this.sql().exec(
      `INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      k,
      String(v),
    );
  }

  metaAdd(k, delta) {
    const next = (Number(this.metaGet(k)) || 0) + delta;
    this.metaSet(k, next);
    return next;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") === "websocket") return this.accept(request);
    if (url.pathname === "/og.png") return this.shareCard();
    if (url.pathname === "/api/stats") return this.statsResponse();
    return new Response("not found", { status: 404 });
  }

  accept(request) {
    const ip = request.headers.get("CF-Connecting-IP") || "local";
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= MAX_SOCKETS) {
      return new Response("the field is packed — try again in a minute", { status: 503 });
    }
    let fromIp = 0;
    for (const socket of sockets) {
      const att = socket.deserializeAttachment();
      if (att?.ip === ip) fromIp++;
    }
    if (fromIp >= MAX_PER_IP) {
      return new Response("too many connections from your network", { status: 429 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ ip, hello: false });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(ws, message) {
    let text;
    try {
      text = typeof message === "string" ? message : new TextDecoder().decode(message);
    } catch {
      return;
    }
    if (text === "ping" || text === "pong") return;
    if (text.length > 1800) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== "string") return;
    try {
      this.onMessage(ws, msg);
    } catch (err) {
      try {
        ws.send(JSON.stringify({ t: "no", reason: "server" }));
      } catch {
        /* socket already gone */
      }
      console.error(err);
    }
  }

  webSocketClose() {
    this.pushPresence();
  }

  alarm() {
    this.maybeAdvance();
  }

  onMessage(ws, msg) {
    this.maybeAdvance();
    const att = ws.deserializeAttachment() || {};
    if (msg.t === "hello") return this.hello(ws, att, msg);
    if (!att.hello) {
      ws.send(JSON.stringify({ t: "no", reason: "hello" }));
      return;
    }
    if (msg.t === "view") return this.onView(ws, att, msg);
    if (msg.t === "cursor") return this.onCursor(ws, att, msg);
    if (msg.t === "name") return this.onName(ws, att, msg);
    if (msg.t === "reveal") return this.onReveal(ws, att, msg);
    if (msg.t === "flag") return this.onFlag(ws, att, msg);
    if (msg.t === "chat") return this.onChat(ws, att, msg);
    if (msg.t === "tick") return;
  }

  hello(ws, att, msg) {
    if (!validPlayerId(msg.id)) {
      ws.send(JSON.stringify({ t: "no", reason: "id" }));
      return;
    }
    const now = Date.now();
    const existing = this.sql().exec(`SELECT * FROM players WHERE id = ?`, msg.id).toArray()[0];
    const color = existing?.color || colorFromId(msg.id);
    const requested = acceptableName(msg.name);
    const kept = existing && !containsSlur(existing.name) ? existing.name : "";
    const name = requested || kept || nameFromId(msg.id);
    if (!existing) {
      this.sql().exec(
        `INSERT INTO players (id, name, color, score, clears, booms, cool, updated) VALUES (?, ?, ?, 0, 0, 0, 0, ?)`,
        msg.id,
        name,
        color,
        now,
      );
    } else if (requested && requested !== existing.name) {
      this.sql().exec(`UPDATE players SET name = ?, updated = ? WHERE id = ?`, requested, now, msg.id);
    } else {
      this.sql().exec(`UPDATE players SET updated = ? WHERE id = ?`, now, msg.id);
    }
    const row = this.sql().exec(`SELECT * FROM players WHERE id = ?`, msg.id).toArray()[0];
    const runtime = this.runtimeFor(row);
    const view = sanitizeView(msg.v) || { x0: -12, y0: -8, x1: 12, y1: 8 };
    const next = {
      ...att,
      hello: true,
      id: row.id,
      name: row.name,
      color: row.color,
      ...view,
    };
    ws.serializeAttachment(next);
    ws.send(JSON.stringify({
      t: "welcome",
      you: publicYou(row, runtime),
      stats: this.publicStats(),
      leaderboard: this.leaderboard(),
      players: this.roster(),
      feed: this.feed,
      cells: this.cellsIn(view.x0, view.y0, view.x1, view.y1),
      cursors: this.cursorsIn(view.x0, view.y0, view.x1, view.y1, row.id),
      chat: this.recentChat(),
      history: this.history(8),
      over: this.phase === "over" ? this.overView() : null,
    }));
    this.pushPresence();
  }

  runtimeFor(row) {
    let runtime = this.runtime.get(row.id);
    if (!runtime) {
      runtime = {
        id: row.id,
        score: row.score | 0,
        clears: row.clears | 0,
        booms: row.booms | 0,
        cooldownUntil: stamp(row.cool),
        revealStamps: [],
        flagStamps: [],
        cellTokens: 200,
        cellTokenAt: Date.now(),
      };
      this.runtime.set(row.id, runtime);
    }
    runtime.score = row.score | 0;
    runtime.clears = row.clears | 0;
    runtime.booms = row.booms | 0;
    runtime.cooldownUntil = Math.max(stamp(runtime.cooldownUntil), stamp(row.cool));
    return runtime;
  }

  onView(ws, att, msg) {
    const view = sanitizeView(msg);
    if (!view) return;
    const next = { ...att, ...view };
    ws.serializeAttachment(next);
    ws.send(JSON.stringify({
      t: "snapshot",
      ...view,
      cells: this.cellsIn(view.x0, view.y0, view.x1, view.y1),
      cursors: this.cursorsIn(view.x0, view.y0, view.x1, view.y1, att.id),
    }));
  }

  onCursor(ws, att, msg) {
    const x = msg.x;
    const y = msg.y;
    if (!inBounds(x, y)) return;
    const now = Date.now();
    if (att.cursorAt && now - att.cursorAt < CURSOR_MS) return;
    if (att.cx === x && att.cy === y) return;
    const next = { ...att, cursorAt: now, cx: x, cy: y };
    ws.serializeAttachment(next);
    const packet = JSON.stringify({
      t: "cursors",
      p: [{ id: att.id, name: att.name, color: att.color, x, y }],
    });
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === ws) continue;
      const other = socket.deserializeAttachment();
      if (!other?.hello) continue;
      if (!sees(other, x, y)) continue;
      try {
        socket.send(packet);
      } catch {
        /* closed */
      }
    }
  }

  onName(ws, att, msg) {
    const name = acceptableName(msg.name);
    if (!name) {
      ws.send(JSON.stringify({ t: "no", reason: "name" }));
      return;
    }
    const now = Date.now();
    this.sql().exec(`UPDATE players SET name = ?, updated = ? WHERE id = ?`, name, now, att.id);
    ws.serializeAttachment({ ...att, name });
    const row = this.sql().exec(`SELECT * FROM players WHERE id = ?`, att.id).toArray()[0];
    ws.send(JSON.stringify({ t: "you", ...publicYou(row, this.runtimeFor(row)) }));
    this.pushPresence();
  }

  onReveal(ws, att, msg) {
    if (this.phase === "over") {
      ws.send(JSON.stringify({ t: "no", reason: "over" }));
      return;
    }
    if (!inBounds(msg.x, msg.y)) {
      ws.send(JSON.stringify({ t: "no", reason: "bounds" }));
      return;
    }
    const row = this.sql().exec(`SELECT * FROM players WHERE id = ?`, att.id).toArray()[0];
    if (!row) return;
    const player = this.runtimeFor(row);
    player.score = row.score | 0;
    player.clears = row.clears | 0;
    player.booms = row.booms | 0;
    const now = Date.now();
    const field = new SqlField(this);
    const margin = CHUNK;
    field.prefetch(msg.x - margin, msg.y - margin, msg.x + margin, msg.y + margin);
    const reason = spareReason(now, this.startedAt, this.shield, att.id);
    const result = attemptDig(field, player, msg.x, msg.y, now, {
      spare: Boolean(reason),
      spareReason: reason,
    });
    if (result.error) {
      ws.send(JSON.stringify({ t: "no", reason: result.error, until: result.until || 0 }));
      return;
    }
    this.persistPlay(att, player, field, result, now);
    this.emitPlay(ws, att, player, field, result);
    if (result.booms?.length) this.finishRound(att, field, result, now);
  }

  onFlag(ws, att, msg) {
    if (this.phase === "over") {
      ws.send(JSON.stringify({ t: "no", reason: "over" }));
      return;
    }
    if (!inBounds(msg.x, msg.y)) {
      ws.send(JSON.stringify({ t: "no", reason: "bounds" }));
      return;
    }
    const row = this.sql().exec(`SELECT * FROM players WHERE id = ?`, att.id).toArray()[0];
    if (!row) return;
    const player = this.runtimeFor(row);
    const now = Date.now();
    const field = new SqlField(this);
    field.prefetch(msg.x, msg.y, msg.x, msg.y);
    const result = attemptFlag(field, player, msg.x, msg.y, now);
    if (result.error) {
      ws.send(JSON.stringify({ t: "no", reason: result.error }));
      return;
    }
    txn(this.ctx, () => {
      field.flush(att.color);
      if (result.flag) this.metaAdd("flags", 1);
    });
    field.commitOverrides();
    const cells = result.flag
      ? [{ x: result.x, y: result.y, k: "f", n: 0, c: att.color }]
      : [{ x: result.x, y: result.y, k: "h", n: 0, c: "" }];
    const packet = { t: "delta", cells, event: null, stats: this.publicStats() };
    this.broadcast(packet, ws, cells);
    try {
      ws.send(JSON.stringify(packet));
    } catch {
      /* actor already gone */
    }
  }

  persistPlay(att, player, field, result, now) {
    const gained = result.cells?.length || 0;
    const found = result.booms?.length || 0;
    txn(this.ctx, () => {
      field.flush(att.color);
      this.sql().exec(
        `UPDATE players SET score = ?, clears = ?, booms = ?, cool = ?, updated = ? WHERE id = ?`,
        player.score | 0,
        player.clears | 0,
        player.booms | 0,
        stamp(player.cooldownUntil),
        now,
        att.id,
      );
      if (gained) {
        this.metaAdd("cleared", gained);
        this.metaAdd("roundCleared", gained);
      }
      if (found) this.metaAdd("booms", found);
      if (gained || found) {
        const event = {
          type: found ? "boom" : "clear",
          id: att.id,
          name: att.name,
          color: att.color,
          x: (result.booms?.[0] || result.cells?.[0] || {}).x ?? 0,
          y: (result.booms?.[0] || result.cells?.[0] || {}).y ?? 0,
          n: gained,
          at: now,
        };
        this.feed.unshift(event);
        this.feed.length = Math.min(this.feed.length, 12);
        this.metaSet("feed", JSON.stringify(this.feed));
        result.event = event;
      }
    });
    field.commitOverrides();
  }

  emitPlay(ws, att, player, field, result) {
    const cells = cellsFromResult(result, att.color, field);
    const stats = this.publicStats();
    const leaderboard = this.leaderboard();
    const event = result.event || null;
    const packet = { t: "delta", cells, event, stats, leaderboard };
    this.broadcast(packet, ws, cells);
    try {
      ws.send(JSON.stringify(packet));
    } catch {
      /* actor already gone */
    }
    ws.send(JSON.stringify({
      t: "you",
      id: att.id,
      name: att.name,
      color: att.color,
      score: player.score | 0,
      clears: player.clears | 0,
      booms: player.booms | 0,
      cooldownUntil: stamp(player.cooldownUntil),
      spared: result.spared || "",
    }));
  }

  broadcast(packet, except, cells) {
    const data = JSON.stringify(packet);
    const slim = cells && cells.length > 40 ? JSON.stringify({ ...packet, cells: [] }) : null;
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
      const att = socket.deserializeAttachment();
      if (!att?.hello) continue;
      let body = data;
      if (slim && cells.length && !boxHits(att, cells)) body = slim;
      try {
        socket.send(body);
      } catch {
        /* closed */
      }
    }
  }

  pushPresence() {
    const packet = JSON.stringify({
      t: "presence",
      stats: this.publicStats(),
      players: this.roster(),
    });
    for (const socket of this.ctx.getWebSockets()) {
      const att = socket.deserializeAttachment();
      if (!att?.hello) continue;
      try {
        socket.send(packet);
      } catch {
        /* closed */
      }
    }
  }

  cellsIn(x0, y0, x1, y1) {
    const rows = this.sql().exec(
      `SELECT x, y, kind, n, color FROM cells WHERE x BETWEEN ? AND ? AND y BETWEEN ? AND ? LIMIT 6000`,
      x0,
      x1,
      y0,
      y1,
    ).toArray();
    return rows.map(wireCell);
  }

  cursorsIn(x0, y0, x1, y1, exceptId) {
    const out = [];
    for (const socket of this.ctx.getWebSockets()) {
      const att = socket.deserializeAttachment();
      if (!att?.hello || att.id === exceptId || att.cx == null) continue;
      if (att.cx < x0 - 2 || att.cx > x1 + 2 || att.cy < y0 - 2 || att.cy > y1 + 2) continue;
      out.push({ id: att.id, name: att.name, color: att.color, x: att.cx, y: att.cy });
      if (out.length >= 40) break;
    }
    return out;
  }

  onlineCount() {
    const seen = new Set();
    for (const socket of this.ctx.getWebSockets()) {
      const att = socket.deserializeAttachment();
      if (att?.hello && att.id) seen.add(att.id);
    }
    return seen.size;
  }

  roster() {
    const out = [];
    const seen = new Set();
    for (const socket of this.ctx.getWebSockets()) {
      const att = socket.deserializeAttachment();
      if (!att?.hello || seen.has(att.id)) continue;
      seen.add(att.id);
      out.push({ id: att.id, name: att.name, color: att.color });
      if (out.length >= 24) break;
    }
    return out;
  }

  publicStats() {
    return {
      cleared: Number(this.metaGet("cleared")) || 0,
      roundCleared: Number(this.metaGet("roundCleared")) || 0,
      booms: Number(this.metaGet("booms")) || 0,
      flags: Number(this.metaGet("flags")) || 0,
      online: this.onlineCount(),
      born: Number(this.metaGet("born")) || 0,
      round: this.round,
      startedAt: this.startedAt,
      phase: this.phase,
      nextAt: this.phase === "over" ? this.nextAt : 0,
      best: { ms: this.bestMs, round: this.bestRound, name: this.bestName },
    };
  }

  leaderboard() {
    return this.sql().exec(
      `SELECT id, name, color, score, clears, booms FROM players ORDER BY score DESC, clears DESC, name ASC LIMIT 8`,
    ).toArray().map((row) => ({
      id: row.id,
      name: row.name,
      color: row.color,
      score: row.score | 0,
      clears: row.clears | 0,
      booms: row.booms | 0,
    }));
  }

  maybeAdvance() {
    if (this.phase !== "over") return;
    if (Date.now() + 40 < this.nextAt) return;
    this.beginRound();
  }

  armAlarm(when) {
    const storage = this.ctx.storage;
    if (!storage || typeof storage.setAlarm !== "function") return;
    Promise.resolve(storage.setAlarm(when)).catch(() => {});
  }

  finishRound(att, field, result, now) {
    const boom = result.booms[0];
    const cleared = Number(this.metaGet("roundCleared")) || 0;
    const duration = Math.max(0, now - this.startedAt);
    const online = Math.max(1, this.onlineCount());
    const line = shameLine({
      name: att.name,
      online,
      round: this.round,
      durationMs: duration,
      cleared,
    });
    txn(this.ctx, () => {
      this.sql().exec(
        `INSERT INTO rounds (n, by_id, by_name, by_color, started, ended, cleared, online)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(n) DO UPDATE SET
           by_id = excluded.by_id,
           by_name = excluded.by_name,
           by_color = excluded.by_color,
           started = excluded.started,
           ended = excluded.ended,
           cleared = excluded.cleared,
           online = excluded.online`,
        this.round,
        att.id,
        att.name,
        att.color,
        this.startedAt,
        now,
        cleared,
        online,
      );
      if (duration >= this.bestMs) {
        this.bestMs = duration;
        this.bestRound = this.round;
        this.bestName = att.name;
        this.metaSet("best_ms", String(duration));
        this.metaSet("best_round", String(this.round));
        this.metaSet("best_name", att.name);
      }
      this.phase = "over";
      this.nextAt = now + INTERMISSION_MS;
      this.over = {
        id: att.id,
        name: att.name,
        color: att.color,
        round: this.round,
        x: boom.x,
        y: boom.y,
        cleared,
        online,
        durationMs: duration,
        line,
        nextAt: this.nextAt,
      };
      this.metaSet("phase", "over");
      this.metaSet("nextAt", String(this.nextAt));
      this.metaSet("over", JSON.stringify(this.over));
    });
    this.armAlarm(this.nextAt);
    const craters = minesAround((x, y) => field.isMine(x, y), boom.x, boom.y).map((cell) => ({
      x: cell.x,
      y: cell.y,
      k: "m",
      n: 0,
      c: att.color,
    }));
    this.broadcastAll({
      t: "over",
      ...this.over,
      cells: craters,
      stats: this.publicStats(),
      best: { ms: this.bestMs, round: this.bestRound, name: this.bestName },
      history: this.history(8),
    });
    this.postChat({ kind: "system", name: "Field", color: att.color, body: line });
  }

  beginRound() {
    if (this.phase !== "over") return;
    const blower = this.over?.id || "";
    const now = Date.now();
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    const seed = String((buf[0] || 1) >>> 0);
    this.phase = "play";
    this.round += 1;
    this.startedAt = now;
    this.shield = blower;
    this.nextAt = 0;
    this.over = null;
    this.seed = Number(seed) >>> 0;
    this.overrides = new Map();
    this.feed = [];
    txn(this.ctx, () => {
      this.sql().exec(`DELETE FROM cells`);
      this.sql().exec(`DELETE FROM overrides`);
      this.sql().exec(`UPDATE players SET score = 0, clears = 0, cool = 0`);
      this.metaSet("seed", seed);
      this.metaSet("round", String(this.round));
      this.metaSet("started", String(now));
      this.metaSet("phase", "play");
      this.metaSet("shield", blower);
      this.metaSet("nextAt", "0");
      this.metaSet("over", "null");
      this.metaSet("roundCleared", "0");
      this.metaSet("feed", "[]");
    });
    for (const runtime of this.runtime.values()) {
      runtime.score = 0;
      runtime.clears = 0;
      runtime.cooldownUntil = 0;
    }
    const stats = this.publicStats();
    this.broadcastAll({
      t: "round",
      round: this.round,
      startedAt: this.startedAt,
      stats,
      leaderboard: this.leaderboard(),
      history: this.history(8),
      best: stats.best,
    });
    this.postChat({
      kind: "system",
      name: "Field",
      color: "#e4b15a",
      body: `Round #${this.round} is open. Fresh dirt. Don't be the one.`,
    });
  }

  onChat(ws, att, msg) {
    const now = Date.now();
    if (!checkChatRate(att.chatAt, now)) {
      ws.send(JSON.stringify({ t: "no", reason: "chat" }));
      return;
    }
    const prepared = prepareChat(msg.text);
    att.chatAt = now;
    ws.serializeAttachment({ ...att, chatAt: now });
    if (prepared.error) {
      ws.send(JSON.stringify({ t: "no", reason: prepared.error }));
      return;
    }
    this.postChat({ kind: "user", name: att.name, color: att.color, body: prepared.body });
  }

  postChat(entry) {
    const now = Date.now();
    this.sql().exec(
      `INSERT INTO chat (at, name, color, body, kind) VALUES (?, ?, ?, ?, ?)`,
      now,
      entry.name || "",
      entry.color || "",
      entry.body,
      entry.kind === "system" ? "system" : "user",
    );
    const row = this.sql().exec(`SELECT id, at, name, color, body, kind FROM chat ORDER BY id DESC LIMIT 1`).toArray()[0];
    const keep = this.sql().exec(`SELECT id FROM chat ORDER BY id DESC LIMIT 1 OFFSET ?`, CHAT_KEEP).toArray()[0];
    if (keep) this.sql().exec(`DELETE FROM chat WHERE id <= ?`, keep.id);
    this.broadcastAll({
      t: "chat",
      msg: {
        id: row.id,
        at: row.at,
        name: row.name,
        color: row.color,
        body: row.body,
        kind: row.kind,
      },
    });
  }

  recentChat() {
    return this.sql().exec(
      `SELECT id, at, name, color, body, kind FROM chat ORDER BY id DESC LIMIT ?`,
      CHAT_KEEP,
    ).toArray().reverse();
  }

  history(limit) {
    return this.sql().exec(
      `SELECT n, by_name, by_color, started, ended, cleared, online FROM rounds ORDER BY n DESC LIMIT ?`,
      limit,
    ).toArray().map((row) => ({
      n: row.n,
      name: row.by_name,
      color: row.by_color,
      durationMs: Math.max(0, Number(row.ended) - Number(row.started)),
      cleared: row.cleared | 0,
      online: row.online | 0,
    }));
  }

  isMineAt(x, y) {
    const hit = this.overrides.get(key(x, y));
    if (hit != null) return hit === 1;
    return deterministicMine(this.seed, x, y);
  }

  overView() {
    if (!this.over) return null;
    const craters = minesAround((x, y) => this.isMineAt(x, y), this.over.x, this.over.y).map((cell) => ({
      x: cell.x,
      y: cell.y,
      k: "m",
      n: 0,
      c: this.over.color,
    }));
    return {
      ...this.over,
      cells: craters,
      best: { ms: this.bestMs, round: this.bestRound, name: this.bestName },
      history: this.history(8),
      stats: this.publicStats(),
    };
  }

  broadcastAll(packet) {
    const data = JSON.stringify(packet);
    for (const socket of this.ctx.getWebSockets()) {
      const att = socket.deserializeAttachment();
      if (!att?.hello) continue;
      try {
        socket.send(data);
      } catch {
        /* closed */
      }
    }
  }

  statsResponse() {
    const body = {
      ...this.publicStats(),
      leaderboard: this.leaderboard(),
    };
    return Response.json(body, {
      headers: {
        "cache-control": "public, max-age=5",
        "access-control-allow-origin": "*",
      },
    });
  }

  async shareCard() {
    const png = await renderShareCard(this.publicStats());
    return new Response(png, {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=30",
      },
    });
  }
}

function stamp(n) {
  const v = typeof n === "bigint" ? Number(n) : Number(n);
  return Number.isFinite(v) ? Math.trunc(v) : 0;
}

function acceptableName(input) {
  const name = cleanName(input);
  if (!name || containsSlur(name)) return null;
  return name;
}

function publicYou(row, runtime) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    score: row.score | 0,
    clears: row.clears | 0,
    booms: row.booms | 0,
    cooldownUntil: Math.max(stamp(row.cool), stamp(runtime?.cooldownUntil)),
  };
}

function wireCell(row) {
  const kind = row.kind === 2 ? "m" : row.kind === 3 ? "f" : "n";
  return { x: row.x, y: row.y, k: kind, n: row.n | 0, c: row.color || "" };
}

function cellsFromResult(result, color, field) {
  const cells = [];
  for (const cell of result.cells || []) {
    cells.push({ x: cell.x, y: cell.y, k: "n", n: cell.n, c: color, f: 1 });
  }
  for (const cell of result.booms || []) {
    cells.push({ x: cell.x, y: cell.y, k: "m", n: 0, c: color, f: 1 });
  }
  for (const cell of result.revisions || []) {
    const prev = field.read(cell.x, cell.y);
    cells.push({ x: cell.x, y: cell.y, k: "n", n: cell.n, c: prev?.color || color });
  }
  return cells;
}

function sanitizeView(v) {
  if (!v) return null;
  const x0 = v.x0;
  const y0 = v.y0;
  const x1 = v.x1;
  const y1 = v.y1;
  if (![x0, y0, x1, y1].every((n) => Number.isInteger(n) && Math.abs(n) <= WORLD)) return null;
  if (x1 < x0 || y1 < y0) return null;
  if (x1 - x0 > VIEW_MAX || y1 - y0 > VIEW_MAX) return null;
  return { x0, y0, x1, y1 };
}

function sees(att, x, y) {
  if (att.x0 == null) return true;
  return x >= att.x0 - 3 && x <= att.x1 + 3 && y >= att.y0 - 3 && y <= att.y1 + 3;
}

function boxHits(att, cells) {
  if (att.x0 == null) return true;
  for (const cell of cells) {
    if (sees(att, cell.x, cell.y)) return true;
  }
  return false;
}

const EMPTY = null;

class SqlField {
  constructor(board) {
    this.board = board;
    this.cache = new Map();
    this.cover = null;
    this.writes = [];
    this.overrideWrites = [];
    this.localOv = new Map();
  }

  prefetch(x0, y0, x1, y1) {
    const a = clampCoord(Math.min(x0, x1));
    const b = clampCoord(Math.max(x0, x1));
    const c = clampCoord(Math.min(y0, y1));
    const d = clampCoord(Math.max(y0, y1));
    this.cover = { x0: a, y0: c, x1: b, y1: d };
    const rows = this.board.sql().exec(
      `SELECT x, y, kind, n, color FROM cells WHERE x BETWEEN ? AND ? AND y BETWEEN ? AND ?`,
      a,
      b,
      c,
      d,
    ).toArray();
    const present = new Set();
    for (const row of rows) {
      const k = key(row.x, row.y);
      present.add(k);
      this.cache.set(k, { kind: row.kind, n: row.n | 0, color: row.color || "" });
    }
    for (let y = c; y <= d; y++) {
      for (let x = a; x <= b; x++) {
        const k = key(x, y);
        if (!present.has(k) && !this.cache.has(k)) this.cache.set(k, EMPTY);
      }
    }
  }

  covers(x, y) {
    return this.cover && x >= this.cover.x0 && x <= this.cover.x1 && y >= this.cover.y0 && y <= this.cover.y1;
  }

  read(x, y) {
    const k = key(x, y);
    if (this.cache.has(k)) return this.cache.get(k);
    if (this.covers(x, y)) {
      this.cache.set(k, EMPTY);
      return EMPTY;
    }
    const row = this.board.sql().exec(
      `SELECT kind, n, color FROM cells WHERE x = ? AND y = ?`,
      x,
      y,
    ).toArray()[0];
    const cell = row ? { kind: row.kind, n: row.n | 0, color: row.color || "" } : EMPTY;
    this.cache.set(k, cell);
    return cell;
  }

  isMine(x, y) {
    const k = key(x, y);
    if (this.localOv.has(k)) return this.localOv.get(k) === 1;
    if (this.board.overrides.has(k)) return this.board.overrides.get(k) === 1;
    return deterministicMine(this.board.seed, x, y);
  }

  isRevealed(x, y) {
    const cell = this.read(x, y);
    return !!cell && cell.kind !== 3;
  }

  isBoom(x, y) {
    const cell = this.read(x, y);
    return !!cell && cell.kind === 2;
  }

  isFlag(x, y) {
    const cell = this.read(x, y);
    return !!cell && cell.kind === 3;
  }

  numberAt(x, y) {
    const cell = this.read(x, y);
    if (!cell || cell.kind === 3) return null;
    return cell.n;
  }

  setOverride(x, y, mine) {
    const bit = mine ? 1 : 0;
    this.localOv.set(key(x, y), bit);
    this.overrideWrites.push({ x, y, mine: bit });
  }

  reveal(x, y, n) {
    const prev = this.read(x, y);
    const kind = n < 0 ? 2 : 1;
    const keep = prev && prev.kind !== 3;
    const cell = { kind, n, color: keep ? prev.color : "" };
    this.cache.set(key(x, y), cell);
    this.writes.push({ x, y, kind, n, color: cell.color, keep: !!keep, del: false });
  }

  setFlag(x, y) {
    this.cache.set(key(x, y), { kind: 3, n: 0, color: "" });
    this.writes.push({ x, y, kind: 3, n: 0, keep: false, del: false });
  }

  clearFlag(x, y) {
    this.cache.set(key(x, y), EMPTY);
    this.writes.push({ x, y, del: true });
  }

  flush(color) {
    const sql = this.board.sql();
    for (const o of this.overrideWrites) {
      sql.exec(
        `INSERT INTO overrides (x, y, mine) VALUES (?, ?, ?)
         ON CONFLICT(x, y) DO UPDATE SET mine = excluded.mine`,
        o.x,
        o.y,
        o.mine,
      );
    }
    for (const w of this.writes) {
      if (w.del) {
        sql.exec(`DELETE FROM cells WHERE x = ? AND y = ?`, w.x, w.y);
        continue;
      }
      const paint = w.keep && w.color ? w.color : color;
      sql.exec(
        `INSERT INTO cells (x, y, kind, n, color) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(x, y) DO UPDATE SET kind = excluded.kind, n = excluded.n, color = excluded.color`,
        w.x,
        w.y,
        w.kind,
        w.n,
        paint,
      );
    }
  }

  commitOverrides() {
    for (const o of this.overrideWrites) {
      this.board.overrides.set(key(o.x, o.y), o.mine);
    }
  }
}

function clampCoord(n) {
  return Math.max(-WORLD, Math.min(WORLD, n | 0));
}
