// Time-bucketed launch stats for the one shared board.
// High-frequency counters stay in memory and flush together.
// Unique people are the anonymous player id already stored on `players`.
// Raw IPs are never written here.

// A hibernating Durable Object is evicted after about 10s with no events, and
// a pending alarm does not keep it in memory. The flush has to run first, or
// the alarm wakes an empty ledger and the quiet stretch is gone.
// https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
export const FLUSH_MS = 8_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export const COUNT_KEYS = [
  "visitors",
  "newPlayers",
  "sessions",
  "digs",
  "cleared",
  "flags",
  "booms",
  "chats",
  "roundsEnded",
  "roundsWon",
  "peakOnline",
];

const COLUMN = {
  visitors: "visitors",
  newPlayers: "new_players",
  sessions: "sessions",
  digs: "digs",
  cleared: "cleared",
  flags: "flags",
  booms: "booms",
  chats: "chats",
  roundsEnded: "rounds_ended",
  roundsWon: "rounds_won",
  peakOnline: "peak_online",
};

export function emptyCounts() {
  return {
    visitors: 0,
    newPlayers: 0,
    sessions: 0,
    digs: 0,
    cleared: 0,
    flags: 0,
    booms: 0,
    chats: 0,
    roundsEnded: 0,
    roundsWon: 0,
    peakOnline: 0,
  };
}

// A burst of play is written before the timer so a restart cannot drop a whole flood.
export function shouldFlushNow(counts) {
  if (!counts) return false;
  const hot = (counts.digs | 0) + (counts.flags | 0) + (counts.chats | 0) + (counts.booms | 0)
    + (counts.sessions | 0) + (counts.roundsEnded | 0) + (counts.roundsWon | 0);
  return hot >= 40 || (counts.cleared | 0) >= 80;
}

export function countsWorthWriting(counts) {
  if (!counts) return false;
  for (const key of COUNT_KEYS) {
    if ((counts[key] | 0) > 0) return true;
  }
  return false;
}

function num(value) {
  const n = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function hourBucket(ts) {
  return Math.floor(num(ts) / HOUR_MS) * HOUR_MS;
}

export function dayBucket(ts) {
  return Math.floor(num(ts) / DAY_MS) * DAY_MS;
}

export function ensureStatsSchema(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS stat_buckets (
    grain TEXT NOT NULL,
    bucket INTEGER NOT NULL,
    visitors INTEGER NOT NULL DEFAULT 0,
    new_players INTEGER NOT NULL DEFAULT 0,
    sessions INTEGER NOT NULL DEFAULT 0,
    digs INTEGER NOT NULL DEFAULT 0,
    cleared INTEGER NOT NULL DEFAULT 0,
    flags INTEGER NOT NULL DEFAULT 0,
    booms INTEGER NOT NULL DEFAULT 0,
    chats INTEGER NOT NULL DEFAULT 0,
    rounds_ended INTEGER NOT NULL DEFAULT 0,
    rounds_won INTEGER NOT NULL DEFAULT 0,
    peak_online INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (grain, bucket)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS stat_seen (
    grain TEXT NOT NULL,
    bucket INTEGER NOT NULL,
    player TEXT NOT NULL,
    PRIMARY KEY (grain, bucket, player)
  )`);
}

export function addCounts(sql, grain, bucket, counts) {
  if (!countsWorthWriting(counts)) return false;
  const c = { ...emptyCounts(), ...counts };
  sql.exec(
    `INSERT INTO stat_buckets (
      grain, bucket, visitors, new_players, sessions, digs, cleared, flags, booms,
      chats, rounds_ended, rounds_won, peak_online
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(grain, bucket) DO UPDATE SET
      visitors = visitors + excluded.visitors,
      new_players = new_players + excluded.new_players,
      sessions = sessions + excluded.sessions,
      digs = digs + excluded.digs,
      cleared = cleared + excluded.cleared,
      flags = flags + excluded.flags,
      booms = booms + excluded.booms,
      chats = chats + excluded.chats,
      rounds_ended = rounds_ended + excluded.rounds_ended,
      rounds_won = rounds_won + excluded.rounds_won,
      peak_online = MAX(peak_online, excluded.peak_online)`,
    grain,
    Math.trunc(Number(bucket) || 0),
    c.visitors | 0,
    c.newPlayers | 0,
    c.sessions | 0,
    c.digs | 0,
    c.cleared | 0,
    c.flags | 0,
    c.booms | 0,
    c.chats | 0,
    c.roundsEnded | 0,
    c.roundsWon | 0,
    c.peakOnline | 0,
  );
  return true;
}

function seenExists(sql, grain, bucket, player) {
  return Boolean(sql.exec(
    `SELECT player FROM stat_seen WHERE grain = ? AND bucket = ? AND player = ?`,
    grain,
    bucket,
    player,
  ).toArray()[0]);
}

// Returns true when this player is new for the bucket. The caller must already
// have rolled the ledger onto `now`, so the in-memory sets match that hour/day.
export function claimVisitor(sql, ledger, playerId, now) {
  const id = String(playerId || "");
  if (!id) return { hour: false, day: false };
  const hour = hourBucket(now);
  const day = dayBucket(now);
  const out = { hour: false, day: false };
  if (!ledger.hourSeen.has(id)) {
    ledger.hourSeen.add(id);
    if (!seenExists(sql, "h", hour, id)) {
      sql.exec(`INSERT INTO stat_seen (grain, bucket, player) VALUES ('h', ?, ?)`, hour, id);
      addCounts(sql, "h", hour, { visitors: 1 });
      out.hour = true;
    }
  }
  if (!ledger.daySeen.has(id)) {
    ledger.daySeen.add(id);
    if (!seenExists(sql, "d", day, id)) {
      sql.exec(`INSERT INTO stat_seen (grain, bucket, player) VALUES ('d', ?, ?)`, day, id);
      addCounts(sql, "d", day, { visitors: 1 });
      out.day = true;
    }
  }
  return out;
}

export function pruneHourSeen(sql, now, limit = 50) {
  const cutoff = hourBucket(now) - 2 * DAY_MS;
  sql.exec(
    `DELETE FROM stat_seen WHERE rowid IN (
      SELECT rowid FROM stat_seen WHERE grain = 'h' AND bucket < ? LIMIT ?
    )`,
    cutoff,
    Math.max(1, limit | 0),
  );
}

export class StatsLedger {
  constructor() {
    this.hourSeen = new Set();
    this.daySeen = new Set();
    this.accHour = 0;
    this.accDay = 0;
    this.pendingHour = emptyCounts();
    this.pendingDay = emptyCounts();
    this.dirty = false;
    this.armed = false;
  }

  // Move counters onto the previous bucket when the clock crosses an hour or day.
  // The caller writes the returned pieces. Seen-sets reset so the next hello
  // checks SQLite again instead of trusting a stale hour.
  ensure(now) {
    const hour = hourBucket(now);
    const day = dayBucket(now);
    const rolled = [];
    if (!this.accHour) {
      this.accHour = hour;
      this.accDay = day;
      return rolled;
    }
    if (hour !== this.accHour) {
      if (countsWorthWriting(this.pendingHour)) {
        rolled.push({ grain: "h", bucket: this.accHour, counts: { ...this.pendingHour } });
      }
      this.pendingHour = emptyCounts();
      this.hourSeen = new Set();
      this.accHour = hour;
    }
    if (day !== this.accDay) {
      if (countsWorthWriting(this.pendingDay)) {
        rolled.push({ grain: "d", bucket: this.accDay, counts: { ...this.pendingDay } });
      }
      this.pendingDay = emptyCounts();
      this.daySeen = new Set();
      this.accDay = day;
    }
    this.dirty = countsWorthWriting(this.pendingHour) || countsWorthWriting(this.pendingDay);
    return rolled;
  }

  add(partial) {
    let changed = false;
    for (const key of COUNT_KEYS) {
      const n = partial?.[key] | 0;
      if (n <= 0) continue;
      changed = true;
      if (key === "peakOnline") {
        if (n > this.pendingHour.peakOnline) this.pendingHour.peakOnline = n;
        if (n > this.pendingDay.peakOnline) this.pendingDay.peakOnline = n;
        continue;
      }
      this.pendingHour[key] += n;
      this.pendingDay[key] += n;
    }
    if (changed) this.dirty = true;
    return changed;
  }

  takeFlush() {
    const pieces = [];
    if (countsWorthWriting(this.pendingHour)) {
      pieces.push({ grain: "h", bucket: this.accHour, counts: { ...this.pendingHour } });
    }
    if (countsWorthWriting(this.pendingDay)) {
      pieces.push({ grain: "d", bucket: this.accDay, counts: { ...this.pendingDay } });
    }
    this.pendingHour = emptyCounts();
    this.pendingDay = emptyCounts();
    this.dirty = false;
    this.armed = false;
    return pieces;
  }

  view() {
    return {
      hour: this.accHour,
      day: this.accDay,
      hourCounts: { ...this.pendingHour },
      dayCounts: { ...this.pendingDay },
    };
  }
}

function earliest(rounds, players, now) {
  let min = num(now) || Date.now();
  for (const round of rounds || []) {
    const started = num(round.started);
    const ended = num(round.ended);
    if (started > 0) min = Math.min(min, started);
    if (ended > 0) min = Math.min(min, ended);
  }
  for (const player of players || []) {
    const updated = num(player.updated);
    if (updated > 0) min = Math.min(min, updated);
  }
  return min;
}

function slot(map, grain, ts) {
  const bucket = grain === "h" ? hourBucket(ts) : dayBucket(ts);
  const key = grain + ":" + bucket;
  let row = map.get(key);
  if (!row) {
    row = { grain, bucket, ...emptyCounts() };
    map.set(key, row);
  }
  return row;
}

function addTo(row, partial) {
  for (const key of COUNT_KEYS) {
    const n = partial[key] | 0;
    if (n <= 0) continue;
    if (key === "peakOnline") row.peakOnline = Math.max(row.peakOnline, n);
    else row[key] += n;
  }
}

// Build bucket rows from the board that already exists. Untimestamped totals
// (flags, and any cleared/booms not explained by the rounds table) land on
// the born day so the all-time sums still match `meta`. Digs and sessions
// have no historical source and stay at zero.
export function planSeed({ meta = {}, rounds = [], players = [], chats = [], now = Date.now() }) {
  const born = num(meta.born) || earliest(rounds, players, now);
  const map = new Map();
  const seen = [];
  let clearedAccounted = 0;
  let boomsAccounted = 0;

  for (const round of rounds) {
    const ended = num(round.ended) || num(round.started) || born;
    const cleared = num(round.cleared);
    const online = num(round.online);
    const win = round.kind === "win";
    const partial = {
      cleared,
      booms: win ? 0 : 1,
      roundsEnded: win ? 0 : 1,
      roundsWon: win ? 1 : 0,
      peakOnline: online,
    };
    addTo(slot(map, "d", ended), partial);
    addTo(slot(map, "h", ended), partial);
    clearedAccounted += cleared;
    if (!win) boomsAccounted += 1;
  }

  const phase = meta.phase || "play";
  const roundCleared = num(meta.roundCleared);
  if (phase !== "over" && roundCleared > 0) {
    const ts = num(meta.started) || born;
    addTo(slot(map, "d", ts), { cleared: roundCleared });
    addTo(slot(map, "h", ts), { cleared: roundCleared });
    clearedAccounted += roundCleared;
  }

  const clearedGap = num(meta.cleared) - clearedAccounted;
  if (clearedGap > 0) addTo(slot(map, "d", born), { cleared: clearedGap });
  const boomsGap = num(meta.booms) - boomsAccounted;
  if (boomsGap > 0) addTo(slot(map, "d", born), { booms: boomsGap });
  const flags = num(meta.flags);
  if (flags > 0) addTo(slot(map, "d", born), { flags });

  const nowHour = hourBucket(now);
  const seenPlayers = new Set();
  for (const player of players) {
    const id = String(player.id || "");
    if (!id || id === "deploycheck-bot01" || seenPlayers.has(id)) continue;
    seenPlayers.add(id);
    const ts = num(player.updated) || born;
    addTo(slot(map, "d", ts), { visitors: 1, newPlayers: 1 });
    addTo(slot(map, "h", ts), { visitors: 1, newPlayers: 1 });
    seen.push({ grain: "d", bucket: dayBucket(ts), player: id });
    if (hourBucket(ts) === nowHour) seen.push({ grain: "h", bucket: nowHour, player: id });
  }

  for (const line of chats) {
    if (line.kind !== "user") continue;
    const ts = num(line.at) || born;
    addTo(slot(map, "d", ts), { chats: 1 });
    addTo(slot(map, "h", ts), { chats: 1 });
  }

  const buckets = [...map.values()].filter((row) => countsWorthWriting(row));
  return { born, buckets, seen };
}

export function applySeed(sql, plan) {
  for (const row of plan.buckets) addCounts(sql, row.grain, row.bucket, row);
  for (const entry of plan.seen) {
    sql.exec(
      `INSERT INTO stat_seen (grain, bucket, player) VALUES (?, ?, ?)
       ON CONFLICT(grain, bucket, player) DO NOTHING`,
      entry.grain,
      entry.bucket,
      entry.player,
    );
  }
}

export function seedIfNeeded(sql, snapshot, now = Date.now()) {
  const flag = sql.exec(`SELECT v FROM meta WHERE k = 'stats_seeded'`).toArray()[0];
  if (flag && flag.v === "1") return null;
  const plan = planSeed({ ...snapshot, now });
  applySeed(sql, plan);
  sql.exec(
    `INSERT INTO meta (k, v) VALUES ('stats_seeded', '1')
     ON CONFLICT(k) DO UPDATE SET v = '1'`,
  );
  return plan;
}

export function rowToCounts(row) {
  const out = emptyCounts();
  if (!row) return out;
  for (const key of COUNT_KEYS) out[key] = num(row[COLUMN[key]]);
  return out;
}

export function mergeCounts(base, extra) {
  const out = { ...emptyCounts(), ...base };
  const add = extra || emptyCounts();
  for (const key of COUNT_KEYS) {
    if (key === "peakOnline") out.peakOnline = Math.max(num(out.peakOnline), num(add.peakOnline));
    else out[key] = num(out[key]) + num(add[key]);
  }
  return out;
}

export function resolveRange(raw, now, born) {
  const key = String(raw || "7d").toLowerCase();
  const endDay = dayBucket(now);
  const endHour = hourBucket(now);
  if (key === "24h" || key === "day" || key === "hour") {
    return { range: "24h", grain: "h", from: endHour - 23 * HOUR_MS, to: endHour, step: HOUR_MS };
  }
  if (key === "30d" || key === "month") {
    return { range: "30d", grain: "d", from: endDay - 29 * DAY_MS, to: endDay, step: DAY_MS };
  }
  if (key === "all") {
    const start = dayBucket(born || now);
    const cap = endDay - 399 * DAY_MS;
    return { range: "all", grain: "d", from: Math.min(endDay, Math.max(start, cap)), to: endDay, step: DAY_MS };
  }
  return { range: "7d", grain: "d", from: endDay - 6 * DAY_MS, to: endDay, step: DAY_MS };
}

export function assembleHistory({
  range,
  now,
  born,
  rows,
  pending,
  todayRow,
  allTime,
  shame,
  fame,
  leaderboard,
  best,
  live,
}) {
  const spec = resolveRange(range, now, born);
  const byTime = new Map();
  for (const row of rows || []) {
    byTime.set(num(row.bucket), rowToCounts(row));
  }
  const pendingCounts = spec.grain === "h" ? pending?.hourCounts : pending?.dayCounts;
  const pendingBucket = spec.grain === "h" ? pending?.hour : pending?.day;
  if (pendingCounts && pendingBucket >= spec.from && pendingBucket <= spec.to) {
    byTime.set(pendingBucket, mergeCounts(byTime.get(pendingBucket) || emptyCounts(), pendingCounts));
  }
  const series = [];
  for (let t = spec.from; t <= spec.to; t += spec.step) {
    series.push({ t, ...(byTime.get(t) || emptyCounts()) });
  }
  let today = rowToCounts(todayRow);
  if (pending?.day === dayBucket(now)) today = mergeCounts(today, pending.dayCounts);
  return {
    range: spec.range,
    grain: spec.grain === "h" ? "hour" : "day",
    from: spec.from,
    to: spec.to,
    born: num(born),
    generatedAt: now,
    today,
    allTime: allTime || emptyCounts(),
    series,
    shame: shame || [],
    fame: fame || [],
    leaderboard: leaderboard || [],
    best: best || { ms: 0, round: 0, name: "" },
    live: live || {},
  };
}

export function countPlayers(sql) {
  const row = sql.exec(`SELECT COUNT(*) AS n FROM players`).toArray()[0];
  return num(row?.n);
}
