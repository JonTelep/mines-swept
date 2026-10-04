// Counting, bucketing, and seeding stats onto a board that already has rounds.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Board } from "../src/board.js";
import { setActiveSize } from "../src/game.js";
import {
  DAY_MS,
  FLUSH_MS,
  HOUR_MS,
  shouldFlushNow,
  StatsLedger,
  addCounts,
  assembleHistory,
  claimVisitor,
  dayBucket,
  emptyCounts,
  ensureStatsSchema,
  hourBucket,
  planSeed,
  resolveRange,
  rowToCounts,
  seedIfNeeded,
} from "../src/stats.js";

function sqlFor(db) {
  return {
    exec(query, ...params) {
      const stmt = db.prepare(query);
      if (/^\s*(select|with)\b/i.test(query)) {
        const rows = stmt.all(...params);
        return { toArray: () => rows };
      }
      stmt.run(...params);
      return { toArray: () => [] };
    },
  };
}

function openDb() {
  const db = new DatabaseSync(":memory:");
  const sql = sqlFor(db);
  return { db, sql };
}

function legacyBoard(sql) {
  sql.exec(`CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
  sql.exec(`CREATE TABLE cells (
    x INTEGER NOT NULL, y INTEGER NOT NULL, kind INTEGER NOT NULL,
    n INTEGER NOT NULL DEFAULT 0, color TEXT, PRIMARY KEY (x, y)
  )`);
  sql.exec(`CREATE TABLE players (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0, clears INTEGER NOT NULL DEFAULT 0,
    booms INTEGER NOT NULL DEFAULT 0, cool INTEGER NOT NULL DEFAULT 0,
    updated INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE overrides (
    x INTEGER NOT NULL, y INTEGER NOT NULL, mine INTEGER NOT NULL, PRIMARY KEY (x, y)
  )`);
  sql.exec(`CREATE TABLE rounds (
    n INTEGER PRIMARY KEY, by_id TEXT, by_name TEXT, by_color TEXT,
    started INTEGER NOT NULL, ended INTEGER NOT NULL,
    cleared INTEGER NOT NULL, online INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE chat (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
    name TEXT, color TEXT, body TEXT NOT NULL, kind TEXT NOT NULL
  )`);
  sql.exec(`CREATE TABLE bins (
    bx INTEGER NOT NULL, by INTEGER NOT NULL,
    revealed INTEGER NOT NULL DEFAULT 0, flags INTEGER NOT NULL DEFAULT 0,
    blast INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (bx, by)
  )`);
}

function metaSet(sql, k, v) {
  sql.exec(
    `INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
    k,
    String(v),
  );
}

function dump(sql, table) {
  return sql.exec(`SELECT * FROM ${table}`).toArray();
}

function bucket(sql, grain, ts) {
  const at = grain === "h" ? hourBucket(ts) : dayBucket(ts);
  const row = sql.exec(
    `SELECT * FROM stat_buckets WHERE grain = ? AND bucket = ?`,
    grain,
    at,
  ).toArray()[0];
  return row ? rowToCounts(row) : emptyCounts();
}

const born = 10 * DAY_MS + 4 * HOUR_MS;
const roundEnd = 11 * DAY_MS + 2 * HOUR_MS;
const winEnd = 11 * DAY_MS + 8 * HOUR_MS;
const playedAt = 12 * DAY_MS + 3 * HOUR_MS;
const now = playedAt + 30 * 60 * 1000;

function seedSnapshot() {
  return {
    meta: {
      cleared: "140",
      booms: "4",
      flags: "25",
      born: String(born),
      round: "3",
      phase: "play",
      started: String(playedAt),
      roundCleared: "40",
      best_ms: "90000",
      best_name: "Ada",
    },
    rounds: [
      {
        n: 1,
        started: born,
        ended: roundEnd,
        cleared: 80,
        online: 6,
        kind: "boom",
        by_name: "Ada",
      },
      {
        n: 2,
        started: roundEnd,
        ended: winEnd,
        cleared: 20,
        online: 3,
        kind: "win",
        by_name: "Bea",
      },
    ],
    players: [
      { id: "player-ada", name: "Ada", updated: roundEnd, clears: 10 },
      { id: "player-bea", name: "Bea", updated: playedAt, clears: 4 },
      { id: "deploycheck-bot01", name: "bot", updated: born, clears: 0 },
    ],
    chats: [
      { at: roundEnd, kind: "user", body: "nice" },
      { at: roundEnd + 1000, kind: "system", body: "Ada blew it" },
      { at: playedAt, kind: "user", body: "again" },
    ],
  };
}

test("a burst flushes before the timer, a handful of digs does not", () => {
  assert.equal(shouldFlushNow({ digs: 3, cleared: 10 }), false);
  assert.equal(shouldFlushNow({ digs: 40 }), true);
  assert.equal(shouldFlushNow({ cleared: 80 }), true);
  assert.equal(shouldFlushNow({ sessions: 39, flags: 1 }), true);
});

test("hour and day buckets are UTC boundaries", () => {
  assert.equal(hourBucket(0), 0);
  assert.equal(hourBucket(HOUR_MS - 1), 0);
  assert.equal(hourBucket(HOUR_MS), HOUR_MS);
  assert.equal(dayBucket(DAY_MS - 1), 0);
  assert.equal(dayBucket(DAY_MS + 5), DAY_MS);
  const spec = resolveRange("nope", now, born);
  assert.equal(spec.range, "7d");
  assert.equal(spec.grain, "d");
  assert.equal(spec.to - spec.from, 6 * DAY_MS);
  const day = resolveRange("24h", now, born);
  assert.equal(day.range, "24h");
  assert.equal(day.to - day.from, 23 * HOUR_MS);
  const all = resolveRange("all", now, born);
  assert.equal(all.from, dayBucket(born));
  assert.equal(all.to, dayBucket(now));
});

test("ledger flushes counters in memory and rolls the hour without dropping the day", () => {
  const ledger = new StatsLedger();
  const t0 = 20 * DAY_MS + 5 * HOUR_MS;
  assert.deepEqual(ledger.ensure(t0), []);
  assert.equal(ledger.add({ digs: 2, cleared: 9, flags: 1, chats: 1, sessions: 1 }), true);
  ledger.add({ peakOnline: 3 });
  ledger.add({ peakOnline: 1 });
  ledger.add({ peakOnline: 4 });
  const view = ledger.view();
  assert.equal(view.hourCounts.digs, 2);
  assert.equal(view.dayCounts.cleared, 9);
  assert.equal(view.hourCounts.peakOnline, 4);
  assert.equal(view.dayCounts.peakOnline, 4);

  const rolled = ledger.ensure(t0 + HOUR_MS + 10);
  assert.equal(rolled.length, 1);
  assert.equal(rolled[0].grain, "h");
  assert.equal(rolled[0].bucket, hourBucket(t0));
  assert.equal(rolled[0].counts.digs, 2);
  assert.equal(ledger.view().hourCounts.digs, 0);
  assert.equal(ledger.view().dayCounts.digs, 2);
  ledger.add({ digs: 1, booms: 1, roundsEnded: 1 });
  const flushed = ledger.takeFlush();
  const hour = flushed.find((piece) => piece.grain === "h");
  const day = flushed.find((piece) => piece.grain === "d");
  assert.equal(hour.bucket, hourBucket(t0 + HOUR_MS));
  assert.equal(hour.counts.digs, 1);
  assert.equal(hour.counts.booms, 1);
  assert.equal(day.bucket, dayBucket(t0));
  assert.equal(day.counts.digs, 3);
  assert.equal(day.counts.roundsEnded, 1);
  assert.equal(ledger.takeFlush().length, 0);
  assert.equal(ledger.dirty, false);
});

test("a visitor counts once per hour and once per day", () => {
  const { sql } = openDb();
  ensureStatsSchema(sql);
  const ledger = new StatsLedger();
  const t0 = 30 * DAY_MS + 2 * HOUR_MS;
  ledger.ensure(t0);
  const first = claimVisitor(sql, ledger, "player-ada", t0);
  const again = claimVisitor(sql, ledger, "player-ada", t0);
  assert.deepEqual(first, { hour: true, day: true });
  assert.deepEqual(again, { hour: false, day: false });
  assert.equal(bucket(sql, "h", t0).visitors, 1);
  assert.equal(bucket(sql, "d", t0).visitors, 1);

  ledger.ensure(t0 + HOUR_MS);
  const nextHour = claimVisitor(sql, ledger, "player-ada", t0 + HOUR_MS);
  assert.deepEqual(nextHour, { hour: true, day: false });
  assert.equal(bucket(sql, "h", t0 + HOUR_MS).visitors, 1);
  assert.equal(bucket(sql, "d", t0).visitors, 1);

  ledger.ensure(t0 + DAY_MS);
  claimVisitor(sql, ledger, "player-ada", t0 + DAY_MS);
  assert.equal(bucket(sql, "d", t0 + DAY_MS).visitors, 1);
  assert.equal(sql.exec(`SELECT COUNT(*) AS n FROM stat_seen`).toArray()[0].n, 5);

  const launch = Date.UTC(2026, 8, 30, 15, 4, 0);
  const later = new StatsLedger();
  later.ensure(launch);
  claimVisitor(sql, later, "player-jon", launch);
  assert.equal(bucket(sql, "d", launch).visitors, 1);
  assert.equal(bucket(sql, "h", launch).visitors, 1);
  claimVisitor(sql, later, "player-jon", launch + 1000);
  assert.equal(bucket(sql, "h", launch).visitors, 1);
});

test("history overlays unflushed counters and fills empty buckets", () => {
  const { sql } = openDb();
  ensureStatsSchema(sql);
  const t0 = dayBucket(now);
  addCounts(sql, "d", t0 - DAY_MS, { cleared: 10, booms: 1 });
  const ledger = new StatsLedger();
  ledger.ensure(now);
  ledger.add({ digs: 4, cleared: 7, sessions: 2 });
  const body = assembleHistory({
    range: "7d",
    now,
    born,
    rows: sql.exec(`SELECT * FROM stat_buckets WHERE grain = 'd'`).toArray(),
    pending: ledger.view(),
    todayRow: sql.exec(`SELECT * FROM stat_buckets WHERE grain = 'd' AND bucket = ?`, t0).toArray()[0],
    allTime: { ...emptyCounts(), digs: 4, cleared: 17 },
  });
  assert.equal(body.series.length, 7);
  assert.equal(body.grain, "day");
  assert.equal(body.series[5].cleared, 10);
  assert.equal(body.series[6].digs, 4);
  assert.equal(body.series[6].cleared, 7);
  assert.equal(body.today.digs, 4);
  assert.equal(body.today.sessions, 2);
  assert.equal(body.series[0].digs, 0);
});

test("seeding an existing board keeps the round, players, halls, chat, and totals", () => {
  const { sql } = openDb();
  legacyBoard(sql);
  sql.exec(`ALTER TABLE rounds ADD COLUMN kind TEXT NOT NULL DEFAULT 'boom'`);
  const snap = seedSnapshot();
  for (const [k, v] of Object.entries(snap.meta)) metaSet(sql, k, v);
  sql.exec(
    `INSERT INTO rounds (n, by_id, by_name, by_color, started, ended, cleared, online, kind)
     VALUES (1, 'player-ada', 'Ada', '#e4b15a', ?, ?, 80, 6, 'boom')`,
    born,
    roundEnd,
  );
  sql.exec(
    `INSERT INTO rounds (n, by_id, by_name, by_color, started, ended, cleared, online, kind)
     VALUES (2, 'player-bea', 'Bea', '#8eae78', ?, ?, 20, 3, 'win')`,
    roundEnd,
    winEnd,
  );
  sql.exec(
    `INSERT INTO players (id, name, color, score, clears, booms, cool, updated)
     VALUES ('player-ada', 'Ada', '#e4b15a', 10, 10, 1, 0, ?)`,
    roundEnd,
  );
  sql.exec(
    `INSERT INTO players (id, name, color, score, clears, booms, cool, updated)
     VALUES ('player-bea', 'Bea', '#8eae78', 4, 4, 0, 0, ?)`,
    playedAt,
  );
  sql.exec(
    `INSERT INTO players (id, name, color, score, clears, booms, cool, updated)
     VALUES ('deploycheck-bot01', 'bot', '#888888', 0, 0, 0, 0, ?)`,
    born,
  );
  sql.exec(
    `INSERT INTO chat (at, name, color, body, kind) VALUES (?, 'Ada', '#e4b15a', 'nice', 'user')`,
    roundEnd,
  );
  sql.exec(
    `INSERT INTO chat (at, name, color, body, kind) VALUES (?, 'Field', '#e4b15a', 'Ada blew it', 'system')`,
    roundEnd + 1000,
  );
  sql.exec(
    `INSERT INTO chat (at, name, color, body, kind) VALUES (?, 'Bea', '#8eae78', 'again', 'user')`,
    playedAt,
  );
  sql.exec(`INSERT INTO cells (x, y, kind, n, color) VALUES (4, 5, 1, 2, '#e4b15a')`);
  sql.exec(`INSERT INTO overrides (x, y, mine) VALUES (8, 8, 1)`);
  sql.exec(`INSERT INTO bins (bx, by, revealed, flags, blast) VALUES (1, 1, 3, 0, 0)`);

  const before = {
    meta: dump(sql, "meta"),
    cells: dump(sql, "cells"),
    players: dump(sql, "players"),
    rounds: dump(sql, "rounds"),
    chat: dump(sql, "chat"),
    overrides: dump(sql, "overrides"),
    bins: dump(sql, "bins"),
  };

  ensureStatsSchema(sql);
  const plan = seedIfNeeded(sql, snap, now);
  assert.ok(plan);

  assert.deepEqual(dump(sql, "cells"), before.cells);
  assert.deepEqual(dump(sql, "players"), before.players);
  assert.deepEqual(dump(sql, "rounds"), before.rounds);
  assert.deepEqual(dump(sql, "chat"), before.chat);
  assert.deepEqual(dump(sql, "overrides"), before.overrides);
  assert.deepEqual(dump(sql, "bins"), before.bins);
  for (const row of before.meta) {
    const after = sql.exec(`SELECT v FROM meta WHERE k = ?`, row.k).toArray()[0];
    assert.equal(after.v, row.v, row.k);
  }
  assert.equal(sql.exec(`SELECT v FROM meta WHERE k = 'stats_seeded'`).toArray()[0].v, "1");

  const bornDay = bucket(sql, "d", born);
  const roundDay = bucket(sql, "d", roundEnd);
  const today = bucket(sql, "d", playedAt);
  assert.equal(bornDay.flags, 25);
  assert.equal(bornDay.booms, 3);
  assert.equal(roundDay.booms, 1);
  assert.equal(roundDay.roundsEnded, 1);
  assert.equal(roundDay.roundsWon, 1);
  assert.equal(roundDay.cleared, 100);
  assert.equal(roundDay.peakOnline, 6);
  assert.equal(roundDay.chats, 1);
  assert.equal(roundDay.visitors, 1);
  assert.equal(roundDay.newPlayers, 1);
  assert.equal(today.cleared, 40);
  assert.equal(today.visitors, 1);
  assert.equal(today.chats, 1);
  assert.equal(today.digs, 0);
  assert.equal(today.sessions, 0);

  const cleared = sql.exec(`SELECT COALESCE(SUM(cleared), 0) AS n FROM stat_buckets WHERE grain = 'd'`).toArray()[0];
  const booms = sql.exec(`SELECT COALESCE(SUM(booms), 0) AS n FROM stat_buckets WHERE grain = 'd'`).toArray()[0];
  assert.equal(Number(cleared.n), 140);
  assert.equal(Number(booms.n), 4);

  const seenPlayers = sql.exec(`SELECT player FROM stat_seen WHERE grain = 'd' ORDER BY player`).toArray();
  assert.deepEqual(seenPlayers.map((row) => row.player), ["player-ada", "player-bea"]);
  const currentHourSeen = sql.exec(
    `SELECT player FROM stat_seen WHERE grain = 'h' AND bucket = ?`,
    hourBucket(now),
  ).toArray();
  assert.deepEqual(currentHourSeen.map((row) => row.player), ["player-bea"]);

  const again = seedIfNeeded(sql, snap, now + 1000);
  assert.equal(again, null);
  const clearedAgain = sql.exec(`SELECT COALESCE(SUM(cleared), 0) AS n FROM stat_buckets WHERE grain = 'd'`).toArray()[0];
  assert.equal(Number(clearedAgain.n), 140);
  assert.equal(sql.exec(`SELECT COUNT(*) AS n FROM stat_seen`).toArray()[0].n, 3);
});

test("an in-progress round is not counted twice while the board is between rounds", () => {
  const snap = seedSnapshot();
  snap.meta.phase = "over";
  snap.meta.roundCleared = "80";
  snap.rounds = [snap.rounds[0]];
  snap.meta.cleared = "80";
  snap.meta.booms = "1";
  const plan = planSeed({ ...snap, now });
  const days = plan.buckets.filter((row) => row.grain === "d");
  const cleared = days.reduce((sum, row) => sum + row.cleared, 0);
  const booms = days.reduce((sum, row) => sum + row.booms, 0);
  assert.equal(cleared, 80);
  assert.equal(booms, 1);
});

function openBoard() {
  const db = new DatabaseSync(":memory:");
  const alarms = [];
  const ctx = {
    storage: {
      sql: sqlFor(db),
      transactionSync(fn) {
        fn();
      },
      setAlarm(when) {
        alarms.push(when);
      },
    },
    blockConcurrencyWhile(fn) {
      return fn();
    },
    getWebSockets() {
      return [];
    },
  };
  const board = new Board(ctx, { BOARD_SIZE: "16" });
  return { board, alarms, sql: ctx.storage.sql };
}

function hourDigs(sql) {
  const row = sql.exec(
    `SELECT COALESCE(SUM(digs), 0) AS digs, COALESCE(SUM(cleared), 0) AS cleared, COALESCE(SUM(flags), 0) AS flags
     FROM stat_buckets WHERE grain = 'h'`,
  ).toArray()[0];
  return { digs: Number(row.digs), cleared: Number(row.cleared), flags: Number(row.flags) };
}

test("buffered stats flush inside the hibernation idle window and on disconnect", () => {
  assert.ok(FLUSH_MS > 0);
  assert.ok(FLUSH_MS < 10_000);
  const { board, alarms, sql } = openBoard();
  try {
    const started = Date.now();
    board.bumpStats({ digs: 3, cleared: 4, flags: 1 });
    assert.equal(board.ledger.dirty, true);
    assert.equal(hourDigs(sql).digs, 0);
    assert.equal(alarms.length, 1);
    assert.ok(alarms[0] >= started + FLUSH_MS - 20);
    assert.ok(alarms[0] <= Date.now() + FLUSH_MS + 20);

    board.webSocketClose();
    assert.deepEqual(hourDigs(sql), { digs: 3, cleared: 4, flags: 1 });
    assert.equal(board.ledger.dirty, false);
    const day = sql.exec(`SELECT COALESCE(SUM(digs), 0) AS digs FROM stat_buckets WHERE grain = 'd'`).toArray()[0];
    assert.equal(Number(day.digs), 3);

    board.webSocketClose();
    board.webSocketError();
    assert.deepEqual(hourDigs(sql), { digs: 3, cleared: 4, flags: 1 });

    board.bumpStats({ digs: 2, chats: 1 });
    assert.equal(hourDigs(sql).digs, 3);
    board.alarm();
    assert.equal(hourDigs(sql).digs, 5);
    const chats = sql.exec(`SELECT COALESCE(SUM(chats), 0) AS chats FROM stat_buckets WHERE grain = 'h'`).toArray()[0];
    assert.equal(Number(chats.chats), 1);
    assert.equal(board.ledger.dirty, false);
  } finally {
    setActiveSize(1000);
  }
});
