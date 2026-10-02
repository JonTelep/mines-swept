// One Durable Object is the whole field: rules, persistence, and presence.
// Hibernating WebSockets keep it asleep between digs. Mines are computed,
// never stored, and never sent unless a player has already detonated them.

import {
  CHUNK,
  attemptDig,
  attemptFlag,
  boardSpan,
  countMines,
  deterministicMine,
  inBounds,
  key,
  setActiveSize,
} from "./game.js";
import { cleanName, colorFromId, nameFromId, validPlayerId } from "./names.js";
import { renderShareCard } from "./png.js";
import { checkChatRate, CHAT_KEEP, prepareChat } from "./chat.js";
import { containsSlur } from "./slurs.js";
import { INTERMISSION_MS, minesAround, shameLine, spareReason, winLine } from "./round.js";
import {
  BIN,
  countDeterministicMines,
  encodeRows,
  resolveBoardSize,
  roundWon,
  safeCells,
} from "./overview.js";
import {
  FLUSH_MS,
  StatsLedger,
  addCounts,
  assembleHistory,
  claimVisitor,
  countPlayers,
  dayBucket,
  ensureStatsSchema,
  hourBucket,
  pruneHourSeen,
  resolveRange,
  seedIfNeeded,
  shouldFlushNow,
} from "./stats.js";

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
    this.boardSize = resolveBoardSize(env?.BOARD_SIZE);
    setActiveSize(this.boardSize);
    this.mineBase = 0;
    this.mineDelta = 0;
    this.dirtyBins = new Map();
    this.ledger = new StatsLedger();
    this.prunedHour = 0;
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
    sql.exec(`CREATE TABLE IF NOT EXISTS bins (
      bx INTEGER NOT NULL,
      by INTEGER NOT NULL,
      revealed INTEGER NOT NULL DEFAULT 0,
      flags INTEGER NOT NULL DEFAULT 0,
      blast INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (bx, by)
    )`);
    try {
      sql.exec(`ALTER TABLE rounds ADD COLUMN kind TEXT NOT NULL DEFAULT 'boom'`);
    } catch {
      /* column already there */
    }
    ensureStatsSchema(sql);
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
      this.metaSet("size", String(this.boardSize));
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
    this.sql().exec(`DELETE FROM players WHERE id = ?`, "deploycheck-bot01");
    this.seedStats();
    const storedSize = Number(this.metaGet("size")) || 0;
    if (storedSize !== this.boardSize) this.adoptFiniteBoard();
    this.mineBase = Number(this.metaGet("mines")) || 0;
    this.mineDelta = Number(this.metaGet("mine_delta")) || 0;
    if (!this.mineBase) {
      this.mineBase = countDeterministicMines(this.seed, this.boardSize);
      this.metaSet("mines", String(this.mineBase));
      this.metaSet("mine_delta", String(this.mineDelta || 0));
    }
    if (this.phase === "over" && this.nextAt && Date.now() >= this.nextAt) {
      this.beginRound();
    } else if (this.phase === "over" && this.nextAt) {
      this.armSoon();
    }
  }

  statsSnapshot() {
    const meta = {};
    for (const row of this.sql().exec(`SELECT k, v FROM meta`).toArray()) meta[row.k] = row.v;
    return {
      meta,
      rounds: this.sql().exec(`SELECT n, started, ended, cleared, online, kind FROM rounds`).toArray(),
      players: this.sql().exec(`SELECT id, updated FROM players`).toArray(),
      chats: this.sql().exec(`SELECT at, kind FROM chat`).toArray(),
    };
  }

  seedStats() {
    if (this.metaGet("stats_seeded") === "1") return;
    const snapshot = this.statsSnapshot();
    const now = Date.now();
    txn(this.ctx, () => {
      seedIfNeeded(this.sql(), snapshot, now);
    });
  }

  writePieces(pieces) {
    if (!pieces?.length) return;
    txn(this.ctx, () => {
      for (const piece of pieces) addCounts(this.sql(), piece.grain, piece.bucket, piece.counts);
    });
  }

  bumpStats(partial) {
    const now = Date.now();
    this.writePieces(this.ledger.ensure(now));
    if (!this.ledger.add(partial)) return;
    // A new player is rare, and flushing here also checkpoints the digs
    // they walked in on, so a restart does not drop the last minute.
    if ((partial.newPlayers | 0) > 0 || shouldFlushNow(this.ledger.pendingDay)) this.flushStats();
    else this.scheduleStats();
  }

  claimPlayer(id) {
    const now = Date.now();
    this.writePieces(this.ledger.ensure(now));
    claimVisitor(this.sql(), this.ledger, id, now);
  }

  flushStats() {
    const now = Date.now();
    const rolled = this.ledger.ensure(now);
    this.ledger.add({ peakOnline: this.onlineCount() });
    const pieces = rolled.concat(this.ledger.takeFlush());
    if (!pieces.length) return;
    txn(this.ctx, () => {
      for (const piece of pieces) addCounts(this.sql(), piece.grain, piece.bucket, piece.counts);
      const hour = hourBucket(now);
      if (this.prunedHour !== hour) {
        try {
          pruneHourSeen(this.sql(), now, 50);
        } catch {
          /* prune is best-effort */
        }
        this.prunedHour = hour;
      }
    });
  }

  scheduleStats() {
    if (this.ledger.armed) return;
    this.ledger.armed = true;
    this.armSoon();
  }

  armSoon() {
    const times = [];
    if (this.phase === "over" && this.nextAt > Date.now() + 20) times.push(this.nextAt);
    if (this.ledger?.dirty) {
      times.push(Date.now() + FLUSH_MS);
      this.ledger.armed = true;
    } else if (this.ledger) {
      this.ledger.armed = false;
    }
    if (!times.length) return;
    this.armAlarm(Math.min(...times));
  }

  adoptFiniteBoard() {
    const now = Date.now();
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    const seed = String((buf[0] || 1) >>> 0);
    const next = (Number(this.metaGet("round")) || 0) + 1;
    this.phase = "play";
    this.round = next;
    this.startedAt = now;
    this.shield = "";
    this.over = null;
    this.nextAt = 0;
    this.seed = Number(seed) >>> 0;
    this.overrides = new Map();
    this.feed = [];
    this.mineDelta = 0;
    this.mineBase = countDeterministicMines(this.seed, this.boardSize);
    const label = this.boardSize.toLocaleString("en-US");
    txn(this.ctx, () => {
      this.sql().exec(`DELETE FROM cells`);
      this.sql().exec(`DELETE FROM overrides`);
      this.sql().exec(`DELETE FROM bins`);
      this.sql().exec(`UPDATE players SET score = 0, clears = 0, cool = 0`);
      this.metaSet("seed", seed);
      this.metaSet("round", String(next));
      this.metaSet("started", String(now));
      this.metaSet("phase", "play");
      this.metaSet("shield", "");
      this.metaSet("nextAt", "0");
      this.metaSet("over", "null");
      this.metaSet("roundCleared", "0");
      this.metaSet("feed", "[]");
      this.metaSet("size", String(this.boardSize));
      this.metaSet("mines", String(this.mineBase));
      this.metaSet("mine_delta", "0");
    });
    this.postChat({
      kind: "system",
      name: "Field",
      color: "#e4b15a",
      body: `The field is fenced. Round #${next} is a ${label} by ${label} board.`,
    });
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
    if (url.pathname === "/api/stats/history") return this.historyResponse(url);
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
    this.bumpStats({ sessions: 1 });
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
    this.flushStats();
    this.maybeAdvance();
    this.armSoon();
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
    if (msg.t === "sweep") return this.onSweep(ws, att);
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
      this.bumpStats({ newPlayers: 1 });
    } else if (requested && requested !== existing.name) {
      this.sql().exec(`UPDATE players SET name = ?, updated = ? WHERE id = ?`, requested, now, msg.id);
    } else {
      this.sql().exec(`UPDATE players SET updated = ? WHERE id = ?`, now, msg.id);
    }
    const row = this.sql().exec(`SELECT * FROM players WHERE id = ?`, msg.id).toArray()[0];
    this.claimPlayer(row.id);
    const runtime = this.runtimeFor(row);
    const view = sanitizeView(msg.v, this.boardSize) || { x0: 0, y0: 0, x1: 24, y1: 16 };
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
      fame: this.fame(8),
      map: this.mapPayload(),
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
    const wide = msg.wide === 1 || msg.wide === true;
    const view = wide
      ? { x0: 0, y0: 0, x1: this.boardSize - 1, y1: this.boardSize - 1, wide: true }
      : sanitizeView(msg, this.boardSize);
    if (!view) return;
    const next = { ...att, ...view, wide: Boolean(wide) };
    ws.serializeAttachment(next);
    if (wide) {
      ws.send(JSON.stringify({ t: "snapshot", wide: true, map: this.mapPayload() }));
      return;
    }
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
    const pin = JSON.stringify({
      t: "pin",
      p: { id: att.id, name: att.name, color: att.color, x, y },
    });
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === ws) continue;
      const other = socket.deserializeAttachment();
      if (other?.hello) {
        try { socket.send(pin); } catch { /* closed */ }
      }
    }
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === ws) continue;
      const other = socket.deserializeAttachment();
      if (!other?.hello) continue;
      if (!other.wide && !sees(other, x, y)) continue;
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
    this.bumpStats({
      digs: 1,
      cleared: result.cells?.length || 0,
      booms: result.booms?.length || 0,
    });
    this.emitPlay(ws, att, player, field, result);
    this.pushMapDelta();
    if (result.booms?.length) this.finishRound(att, field, result, now);
    else if (roundWon(Number(this.metaGet("roundCleared")) || 0, this.safeCount())) this.finishWin(att, now);
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
    if (result.flag) this.bumpStats({ flags: 1 });
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
    this.pushMapDelta();
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
    this.bumpStats({ peakOnline: this.onlineCount() });
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
      size: this.boardSize,
      safe: this.safeCount(),
      best: { ms: this.bestMs, round: this.bestRound, name: this.bestName },
    };
  }

  safeCount() {
    return safeCells(this.boardSize, this.mineBase + this.mineDelta);
  }

  leaderboard() {
    return this.sql().exec(
      `SELECT id, name, color, score, clears, booms FROM players
       WHERE clears > 0
       ORDER BY score DESC, clears DESC, name ASC LIMIT 8`,
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
        `INSERT INTO rounds (n, by_id, by_name, by_color, started, ended, cleared, online, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'boom')
         ON CONFLICT(n) DO UPDATE SET
           by_id = excluded.by_id,
           by_name = excluded.by_name,
           by_color = excluded.by_color,
           started = excluded.started,
           ended = excluded.ended,
           cleared = excluded.cleared,
           online = excluded.online,
           kind = 'boom'`,
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
    this.bumpStats({ roundsEnded: 1 });
    this.flushStats();
    this.armSoon();
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
      fame: this.fame(8),
    });
    this.postChat({ kind: "system", name: "Field", color: att.color, body: line });
  }

  finishWin(att, now) {
    const cleared = Number(this.metaGet("roundCleared")) || 0;
    const duration = Math.max(0, now - this.startedAt);
    const online = Math.max(1, this.onlineCount());
    const tops = this.leaderboard();
    const leader = tops[0] || null;
    const line = winLine({
      round: this.round,
      durationMs: duration,
      cleared,
      leader,
    });
    txn(this.ctx, () => {
      this.sql().exec(
        `INSERT INTO rounds (n, by_id, by_name, by_color, started, ended, cleared, online, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'win')
         ON CONFLICT(n) DO UPDATE SET
           by_id = excluded.by_id,
           by_name = excluded.by_name,
           by_color = excluded.by_color,
           started = excluded.started,
           ended = excluded.ended,
           cleared = excluded.cleared,
           online = excluded.online,
           kind = 'win'`,
        this.round,
        leader?.id || att.id,
        leader?.name || att.name,
        leader?.color || att.color,
        this.startedAt,
        now,
        cleared,
        online,
      );
      if (duration >= this.bestMs) {
        this.bestMs = duration;
        this.bestRound = this.round;
        this.bestName = leader?.name || att.name;
        this.metaSet("best_ms", String(duration));
        this.metaSet("best_round", String(this.round));
        this.metaSet("best_name", this.bestName);
      }
      this.phase = "over";
      this.nextAt = now + INTERMISSION_MS;
      this.over = {
        id: "",
        win: true,
        name: leader?.name || "Everyone",
        color: leader?.color || "#8eae78",
        round: this.round,
        cleared,
        online,
        durationMs: duration,
        line,
        nextAt: this.nextAt,
        tops,
      };
      this.metaSet("phase", "over");
      this.metaSet("nextAt", String(this.nextAt));
      this.metaSet("over", JSON.stringify(this.over));
    });
    this.bumpStats({ roundsWon: 1 });
    this.flushStats();
    this.armSoon();
    this.broadcastAll({
      t: "win",
      ...this.over,
      stats: this.publicStats(),
      best: { ms: this.bestMs, round: this.bestRound, name: this.bestName },
      history: this.history(8),
      fame: this.fame(8),
    });
    this.postChat({ kind: "system", name: "Field", color: "#8eae78", body: line });
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
    this.dirtyBins = new Map();
    this.mineBase = countDeterministicMines(this.seed, this.boardSize);
    this.mineDelta = 0;
    txn(this.ctx, () => {
      this.sql().exec(`DELETE FROM cells`);
      this.sql().exec(`DELETE FROM overrides`);
      this.sql().exec(`DELETE FROM bins`);
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
      this.metaSet("mines", String(this.mineBase));
      this.metaSet("mine_delta", "0");
      this.metaSet("size", String(this.boardSize));
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
      fame: this.fame(8),
      best: stats.best,
      map: { n: Math.ceil(this.boardSize / BIN), bins: "", reset: true },
    });
    this.postChat({
      kind: "system",
      name: "Field",
      color: "#e4b15a",
      body: `Round #${this.round} is open. ${this.boardSize.toLocaleString("en-US")} by ${this.boardSize.toLocaleString("en-US")}. Don't be the one.`,
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
    this.bumpStats({ chats: 1 });
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
    return this.hallQuery(`kind IS NULL OR kind = 'boom'`, limit);
  }

  fame(limit) {
    return this.hallQuery(`kind = 'win'`, limit);
  }

  hallQuery(where, limit) {
    return this.sql().exec(
      `SELECT n, by_name, by_color, started, ended, cleared, online, kind FROM rounds
       WHERE ${where} ORDER BY n DESC LIMIT ?`,
      limit,
    ).toArray().map((row) => ({
      n: row.n,
      name: row.by_name,
      color: row.by_color,
      durationMs: Math.max(0, Number(row.ended) - Number(row.started)),
      cleared: row.cleared | 0,
      online: row.online | 0,
      kind: row.kind === "win" ? "win" : "boom",
    }));
  }

  mapPayload() {
    const rows = this.sql().exec(`SELECT bx, by, revealed, flags, blast FROM bins`).toArray();
    return {
      n: Math.ceil(this.boardSize / BIN),
      bins: encodeRows(rows),
      count: rows.length,
    };
  }

  pushMapDelta() {
    if (!this.dirtyBins || !this.dirtyBins.size) return;
    const rows = [...this.dirtyBins.values()];
    this.dirtyBins.clear();
    this.broadcastAll({
      t: "map",
      n: Math.ceil(this.boardSize / BIN),
      bins: encodeRows(rows),
    });
  }

  bumpBin(x, y, dRev, dFlag, blast) {
    if (!dRev && !dFlag && !blast) return;
    const bx = Math.floor(x / BIN);
    const by = Math.floor(y / BIN);
    if (bx < 0 || by < 0) return;
    const id = bx + "," + by;
    let row = this.dirtyBins.get(id);
    if (!row) {
      const found = this.sql().exec(
        `SELECT bx, by, revealed, flags, blast FROM bins WHERE bx = ? AND by = ?`,
        bx,
        by,
      ).toArray()[0];
      row = found
        ? { bx, by, revealed: found.revealed | 0, flags: found.flags | 0, blast: found.blast ? 1 : 0 }
        : { bx, by, revealed: 0, flags: 0, blast: 0 };
    }
    row.revealed = Math.max(0, row.revealed + dRev);
    row.flags = Math.max(0, row.flags + dFlag);
    if (blast) row.blast = 1;
    this.sql().exec(
      `INSERT INTO bins (bx, by, revealed, flags, blast) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(bx, by) DO UPDATE SET
         revealed = excluded.revealed,
         flags = excluded.flags,
         blast = excluded.blast`,
      bx,
      by,
      row.revealed,
      row.flags,
      row.blast,
    );
    this.dirtyBins.set(id, row);
  }

  onSweep(ws, att) {
    if (String(this.env?.TEST_HOOKS) !== "1" || this.boardSize > 48 || this.phase !== "play") {
      ws.send(JSON.stringify({ t: "no", reason: "bounds" }));
      return;
    }
    const row = this.sql().exec(`SELECT * FROM players WHERE id = ?`, att.id).toArray()[0];
    if (!row) return;
    const hidden = [];
    for (let y = 0; y < this.boardSize; y++) {
      for (let x = 0; x < this.boardSize; x++) {
        if (this.isMineAt(x, y)) continue;
        const cell = this.sql().exec(`SELECT kind FROM cells WHERE x = ? AND y = ?`, x, y).toArray()[0];
        if (cell && cell.kind !== 3) continue;
        hidden.push([x, y]);
      }
    }
    if (hidden.length <= 1) {
      const last = hidden[0] || [-1, -1];
      ws.send(JSON.stringify({ t: "left", x: last[0], y: last[1] }));
      return;
    }
    const last = hidden.pop();
    const color = att.color;
    let opened = 0;
    txn(this.ctx, () => {
      for (const [x, y] of hidden) {
        const prev = this.sql().exec(`SELECT kind FROM cells WHERE x = ? AND y = ?`, x, y).toArray()[0];
        const n = countMines({ isMine: (cx, cy) => this.isMineAt(cx, cy) }, x, y);
        this.sql().exec(
          `INSERT INTO cells (x, y, kind, n, color) VALUES (?, ?, 1, ?, ?)
           ON CONFLICT(x, y) DO UPDATE SET kind = 1, n = excluded.n, color = excluded.color`,
          x,
          y,
          n,
          color,
        );
        this.bumpBin(x, y, 1, prev && prev.kind === 3 ? -1 : 0, 0);
        opened++;
      }
      this.metaAdd("cleared", opened);
      this.metaAdd("roundCleared", opened);
      const player = this.runtimeFor(row);
      player.score = (row.score | 0) + opened;
      player.clears = (row.clears | 0) + opened;
      this.sql().exec(
        `UPDATE players SET score = ?, clears = ?, updated = ? WHERE id = ?`,
        player.score,
        player.clears,
        Date.now(),
        att.id,
      );
    });
    this.pushMapDelta();
    this.broadcastAll({
      t: "presence",
      stats: this.publicStats(),
      players: this.roster(),
    });
    ws.send(JSON.stringify({ t: "left", x: last[0], y: last[1], n: opened }));
  }

  isMineAt(x, y) {
    const hit = this.overrides.get(key(x, y));
    if (hit != null) return hit === 1;
    return deterministicMine(this.seed, x, y);
  }

  overView() {
    if (!this.over) return null;
    if (this.over.win) {
      return {
        ...this.over,
        best: { ms: this.bestMs, round: this.bestRound, name: this.bestName },
        history: this.history(8),
        fame: this.fame(8),
        stats: this.publicStats(),
      };
    }
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
      visitors: countPlayers(this.sql()),
      leaderboard: this.leaderboard(),
    };
    return Response.json(body, {
      headers: {
        "cache-control": "public, max-age=5",
        "access-control-allow-origin": "*",
      },
    });
  }

  historyResponse(url) {
    const now = Date.now();
    this.writePieces(this.ledger.ensure(now));
    const born = Number(this.metaGet("born")) || now;
    const spec = resolveRange(url.searchParams.get("range"), now, born);
    const rows = this.sql().exec(
      `SELECT grain, bucket, visitors, new_players, sessions, digs, cleared, flags, booms, chats,
              rounds_ended, rounds_won, peak_online
       FROM stat_buckets WHERE grain = ? AND bucket >= ? AND bucket <= ?`,
      spec.grain,
      spec.from,
      spec.to,
    ).toArray();
    const todayRow = this.sql().exec(
      `SELECT grain, bucket, visitors, new_players, sessions, digs, cleared, flags, booms, chats,
              rounds_ended, rounds_won, peak_online
       FROM stat_buckets WHERE grain = 'd' AND bucket = ?`,
      dayBucket(now),
    ).toArray()[0];
    const sums = this.sql().exec(
      `SELECT
         COALESCE(SUM(sessions), 0) AS sessions,
         COALESCE(SUM(digs), 0) AS digs,
         COALESCE(SUM(chats), 0) AS chats,
         COALESCE(MAX(peak_online), 0) AS peak_online
       FROM stat_buckets WHERE grain = 'd'`,
    ).toArray()[0];
    const roundCounts = this.sql().exec(
      `SELECT
         COALESCE(SUM(CASE WHEN kind = 'win' THEN 1 ELSE 0 END), 0) AS wins,
         COALESCE(SUM(CASE WHEN kind IS NULL OR kind != 'win' THEN 1 ELSE 0 END), 0) AS ended
       FROM rounds`,
    ).toArray()[0];
    const pending = this.ledger.view();
    const players = countPlayers(this.sql());
    const allTime = {
      visitors: players,
      newPlayers: players,
      sessions: stamp(sums?.sessions) + (pending.dayCounts.sessions | 0),
      digs: stamp(sums?.digs) + (pending.dayCounts.digs | 0),
      cleared: Number(this.metaGet("cleared")) || 0,
      flags: Number(this.metaGet("flags")) || 0,
      booms: Number(this.metaGet("booms")) || 0,
      chats: stamp(sums?.chats) + (pending.dayCounts.chats | 0),
      roundsEnded: stamp(roundCounts?.ended),
      roundsWon: stamp(roundCounts?.wins),
      peakOnline: Math.max(
        stamp(sums?.peak_online),
        pending.dayCounts.peakOnline | 0,
        pending.hourCounts.peakOnline | 0,
      ),
    };
    const body = assembleHistory({
      range: url.searchParams.get("range"),
      now,
      born,
      rows,
      pending,
      todayRow,
      allTime,
      shame: this.history(8),
      fame: this.fame(8),
      leaderboard: this.leaderboard().map((row) => ({
        name: row.name,
        color: row.color,
        score: row.score,
        clears: row.clears,
        booms: row.booms,
      })),
      best: { ms: this.bestMs, round: this.bestRound, name: this.bestName },
      live: this.publicStats(),
    });
    return Response.json(body, {
      headers: {
        "cache-control": "public, max-age=5",
        "access-control-allow-origin": "*",
      },
    });
  }

  async shareCard() {
    const stats = this.publicStats();
    stats.visitors = countPlayers(this.sql());
    const png = await renderShareCard(stats);
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

function sanitizeView(v, size) {
  if (!v) return null;
  const x0 = v.x0;
  const y0 = v.y0;
  const x1 = v.x1;
  const y1 = v.y1;
  const span = size || boardSpan();
  if (![x0, y0, x1, y1].every((n) => Number.isInteger(n))) return null;
  if (x1 < x0 || y1 < y0) return null;
  if (x1 - x0 > VIEW_MAX || y1 - y0 > VIEW_MAX) return null;
  if (x0 < -VIEW_MAX || y0 < -VIEW_MAX || x1 > span + VIEW_MAX || y1 > span + VIEW_MAX) return null;
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
    const wasFlag = !!(prev && prev.kind === 3);
    const wasOpen = !!(prev && prev.kind && prev.kind !== 3);
    const keep = wasOpen;
    const cell = { kind, n, color: keep ? prev.color : "" };
    this.cache.set(key(x, y), cell);
    this.writes.push({
      x,
      y,
      kind,
      n,
      color: cell.color,
      keep: !!keep,
      del: false,
      dRev: wasOpen ? 0 : 1,
      dFlag: wasFlag ? -1 : 0,
      blast: n < 0 ? 1 : 0,
    });
  }

  setFlag(x, y) {
    this.cache.set(key(x, y), { kind: 3, n: 0, color: "" });
    this.writes.push({ x, y, kind: 3, n: 0, keep: false, del: false, dRev: 0, dFlag: 1, blast: 0 });
  }

  clearFlag(x, y) {
    this.cache.set(key(x, y), EMPTY);
    this.writes.push({ x, y, del: true, dRev: 0, dFlag: -1, blast: 0 });
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
      if (w.dRev || w.dFlag || w.blast) this.board.bumpBin(w.x, w.y, w.dRev || 0, w.dFlag || 0, w.blast || 0);
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
      const k = key(o.x, o.y);
      const prevBit = this.board.overrides.has(k)
        ? (this.board.overrides.get(k) ? 1 : 0)
        : (deterministicMine(this.board.seed, o.x, o.y) ? 1 : 0);
      const nextBit = o.mine ? 1 : 0;
      if (prevBit !== nextBit) this.board.mineDelta += nextBit ? 1 : -1;
      this.board.overrides.set(k, nextBit);
    }
    if (this.overrideWrites.length) {
      this.board.metaSet("mine_delta", String(this.board.mineDelta));
    }
  }
}

function clampCoord(n) {
  const size = boardSpan();
  return Math.max(0, Math.min(size - 1, n | 0));
}
