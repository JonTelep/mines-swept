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

  onMessage(ws, msg) {
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
  }

  hello(ws, att, msg) {
    if (!validPlayerId(msg.id)) {
      ws.send(JSON.stringify({ t: "no", reason: "id" }));
      return;
    }
    const now = Date.now();
    const existing = this.sql().exec(`SELECT * FROM players WHERE id = ?`, msg.id).toArray()[0];
    const color = existing?.color || colorFromId(msg.id);
    const requested = cleanName(msg.name);
    const name = requested || existing?.name || nameFromId(msg.id);
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
        cooldownUntil: row.cool | 0,
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
    runtime.cooldownUntil = Math.max(runtime.cooldownUntil | 0, row.cool | 0);
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
    const name = cleanName(msg.name);
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
    const result = attemptDig(field, player, msg.x, msg.y, now);
    if (result.error) {
      ws.send(JSON.stringify({ t: "no", reason: result.error, until: result.until || 0 }));
      return;
    }
    this.persistPlay(att, player, field, result, now);
    this.emitPlay(ws, att, player, field, result);
  }

  onFlag(ws, att, msg) {
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
        player.cooldownUntil | 0,
        now,
        att.id,
      );
      if (gained) this.metaAdd("cleared", gained);
      if (found) this.metaAdd("booms", found);
      if (gained || found) {
        const event = {
          type: found ? "boom" : "clear",
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
      cooldownUntil: player.cooldownUntil | 0,
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
      booms: Number(this.metaGet("booms")) || 0,
      flags: Number(this.metaGet("flags")) || 0,
      online: this.onlineCount(),
      born: Number(this.metaGet("born")) || 0,
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

function publicYou(row, runtime) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    score: row.score | 0,
    clears: row.clears | 0,
    booms: row.booms | 0,
    cooldownUntil: Math.max(row.cool | 0, runtime?.cooldownUntil | 0),
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
