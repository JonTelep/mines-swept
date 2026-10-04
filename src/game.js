// Pure minesweeper rules for one shared finite board.
// Mines come from a seed unless a persisted override says otherwise.
// Nothing in this file touches the network or storage.

export const CHUNK = 32;
export const BOARD = 1000;
// 17.5% — same density as the old open field. On 1,000×1,000 that is
// about 175,000 mines, expert-ish, without turning the clear into a bigger write.
export const MINE_PER_10K = 1750;
let activeSize = BOARD;

export function setActiveSize(n) {
  const size = n | 0;
  if (size >= 8 && size <= BOARD) activeSize = size;
}

export function boardSpan() {
  return activeSize;
}
export const DEFAULT_FLOOD_MAX = 400;
export const BOOM_PENALTY = 25;
export const COOLDOWN_MS = 8000;
export const REVEALS_PER_SEC = 6;
export const FLAGS_PER_SEC = 10;
const CELL_CAP = 260;
const CELL_PER_SEC = 45;
const START_TOKENS = 200;

export function key(x, y) {
  return x + "," + y;
}

export function inBounds(x, y) {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < activeSize && y < activeSize;
}

export function neighbors(x, y) {
  const out = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx || dy) out.push([x + dx, y + dy]);
    }
  }
  return out;
}

// Deterministic 32-bit mix. Same seed and cell always return the same mine bit.
export function mix32(seed, x, y) {
  let h = seed >>> 0;
  h = Math.imul(h ^ (x | 0), 0x85ebca6b);
  h = Math.imul(h ^ (y | 0), 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

export function deterministicMine(seed, x, y) {
  if (!inBounds(x, y)) return false;
  return mix32(seed, x, y) % 10000 < MINE_PER_10K;
}

export function minesInChunk(seed, cx, cy) {
  const mines = [];
  const x0 = cx * CHUNK;
  const y0 = cy * CHUNK;
  for (let y = 0; y < CHUNK; y++) {
    for (let x = 0; x < CHUNK; x++) {
      const wx = x0 + x;
      const wy = y0 + y;
      if (deterministicMine(seed, wx, wy)) mines.push([wx, wy]);
    }
  }
  return mines;
}

export function chunkChecksum(seed, cx, cy) {
  let h = 2166136261;
  for (const [x, y] of minesInChunk(seed, cx, cy)) {
    h ^= (x + Math.imul(y, 0x9e3779b1)) >>> 0;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function countMines(field, x, y) {
  let n = 0;
  for (const [nx, ny] of neighbors(x, y)) {
    if (field.isMine(nx, ny)) n++;
  }
  return n;
}

// A cell is virgin when none of its neighbors have been revealed, so moving a
// mine here cannot change a number anyone has already seen.
export function isVirgin(field, x, y) {
  for (const [nx, ny] of neighbors(x, y)) {
    if (field.isRevealed(nx, ny)) return false;
  }
  return true;
}

export function findRelocation(field, x, y) {
  let best = null;
  let bestD = -1;
  const consider = (xx, yy) => {
    if ((xx === x && yy === y) || !inBounds(xx, yy)) return;
    if (field.isMine(xx, yy) || field.isRevealed(xx, yy) || field.isFlag(xx, yy)) return;
    if (!isVirgin(field, xx, yy)) return;
    const d = Math.abs(xx - x) + Math.abs(yy - y);
    const better =
      !best ||
      d > bestD ||
      (d === bestD && (xx < best.x || (xx === best.x && yy < best.y)));
    if (better) {
      best = { x: xx, y: yy };
      bestD = d;
    }
  };

  const cx = Math.floor(x / CHUNK) * CHUNK;
  const cy = Math.floor(y / CHUNK) * CHUNK;
  const scanChunk = (x0, y0) => {
    for (let yy = y0; yy < y0 + CHUNK; yy++) {
      for (let xx = x0; xx < x0 + CHUNK; xx++) consider(xx, yy);
    }
  };
  scanChunk(cx, cy);
  if (best) return best;
  for (let r = 1; r <= 3; r++) {
    for (let dc = -r; dc <= r; dc++) {
      for (let dr = -r; dr <= r; dr++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== r) continue;
        scanChunk(cx + dc * CHUNK, cy + dr * CHUNK);
      }
    }
    if (best) return best;
  }
  return null;
}

function emptyChanges() {
  return { cells: [], booms: [], revisions: [], overrides: [], relocated: null, capped: false };
}

function boom(field, x, y, changes) {
  field.reveal(x, y, -1);
  changes.booms.push({ x, y });
}

// If a flood has to stop early, plant mines on the hidden safe neighbors of
// any revealed zero so every visible number stays true.
function seal(field, changes) {
  const zeros = [];
  for (const cell of changes.cells) {
    if (cell.n === 0) zeros.push(cell);
  }
  for (const z of zeros) {
    if (z.n !== 0) continue;
    for (const [nx, ny] of neighbors(z.x, z.y)) {
      if (!inBounds(nx, ny)) continue;
      if (field.isRevealed(nx, ny) || field.isMine(nx, ny)) continue;
      field.setOverride(nx, ny, true);
      changes.overrides.push({ x: nx, y: ny, mine: 1 });
      for (const [rx, ry] of neighbors(nx, ny)) {
        if (!field.isRevealed(rx, ry) || field.isBoom(rx, ry)) continue;
        const nn = countMines(field, rx, ry);
        field.reveal(rx, ry, nn);
        const fresh = changes.cells.find((c) => c.x === rx && c.y === ry);
        if (fresh) fresh.n = nn;
        else {
          const rev = changes.revisions.find((c) => c.x === rx && c.y === ry);
          if (rev) rev.n = nn;
          else changes.revisions.push({ x: rx, y: ry, n: nn });
        }
      }
    }
  }
}

function noteNumber(changes, x, y, n) {
  const fresh = changes.cells.find((c) => c.x === x && c.y === y);
  if (fresh) {
    fresh.n = n;
    return;
  }
  const rev = changes.revisions.find((c) => c.x === x && c.y === y);
  if (rev) rev.n = n;
  else changes.revisions.push({ x, y, n });
}

function reviseAround(field, x, y, changes) {
  for (const [nx, ny] of neighbors(x, y)) {
    if (!field.isRevealed(nx, ny) || field.isBoom(nx, ny)) continue;
    const nn = countMines(field, nx, ny);
    field.reveal(nx, ny, nn);
    noteNumber(changes, nx, ny, nn);
  }
}

function releaseMine(field, x, y, changes) {
  const dest = findRelocation(field, x, y);
  field.setOverride(x, y, false);
  changes.overrides.push({ x, y, mine: 0 });
  if (dest) {
    field.setOverride(dest.x, dest.y, true);
    changes.overrides.push({ x: dest.x, y: dest.y, mine: 1 });
    changes.relocated = { x, y, toX: dest.x, toY: dest.y };
  } else {
    changes.relocated = { x, y, toX: x, toY: y, removed: true };
  }
  reviseAround(field, x, y, changes);
  if (dest) reviseAround(field, dest.x, dest.y, changes);
}

function floodFrom(field, x, y, max, changes, spare, spareReason) {
  if (!inBounds(x, y) || field.isFlag(x, y) || field.isRevealed(x, y)) return;
  if (field.isMine(x, y)) {
    if (spare) {
      if (!isVirgin(field, x, y)) changes.spared = spareReason || "grace";
      releaseMine(field, x, y, changes);
    } else {
      boom(field, x, y, changes);
      return;
    }
  }
  const queue = [[x, y]];
  const seen = new Set();
  let guard = 0;
  while (queue.length && guard++ < max * 16 + 64) {
    const [cx, cy] = queue.shift();
    const k = key(cx, cy);
    if (seen.has(k)) continue;
    seen.add(k);
    if (!inBounds(cx, cy) || field.isRevealed(cx, cy) || field.isFlag(cx, cy)) continue;
    if (field.isMine(cx, cy)) continue;
    if (changes.cells.length >= max) {
      changes.capped = true;
      continue;
    }
    const n = countMines(field, cx, cy);
    field.reveal(cx, cy, n);
    changes.cells.push({ x: cx, y: cy, n });
    if (n === 0) {
      for (const nb of neighbors(cx, cy)) queue.push(nb);
    }
  }
  if (changes.capped) seal(field, changes);
}

export function dig(field, x, y, opts = {}) {
  if (!inBounds(x, y)) return { error: "bounds" };
  if (field.isFlag(x, y)) return { error: "flagged" };
  if (field.isRevealed(x, y)) {
    if (field.isBoom(x, y)) return { error: "revealed" };
    return chord(field, x, y, opts);
  }

  const changes = emptyChanges();
  const max = Math.max(1, opts.max ?? DEFAULT_FLOOD_MAX);
  const spare = Boolean(opts.spare);

  if (field.isMine(x, y) && (isVirgin(field, x, y) || spare)) {
    if (!isVirgin(field, x, y)) changes.spared = opts.spareReason || "grace";
    releaseMine(field, x, y, changes);
  }

  floodFrom(field, x, y, max, changes, spare, opts.spareReason);
  return changes;
}

function chord(field, x, y, opts) {
  const n = field.numberAt(x, y);
  const neigh = neighbors(x, y).filter(([nx, ny]) => inBounds(nx, ny));
  let flags = 0;
  for (const [nx, ny] of neigh) if (field.isFlag(nx, ny)) flags++;
  if (flags !== n) return { error: "chord" };

  const changes = emptyChanges();
  changes.chord = true;
  let budget = Math.max(1, opts.max ?? DEFAULT_FLOOD_MAX);
  for (const [nx, ny] of neigh) {
    if (field.isFlag(nx, ny) || field.isRevealed(nx, ny)) continue;
    const before = changes.cells.length;
    floodFrom(field, nx, ny, Math.max(1, budget), changes, Boolean(opts.spare), opts.spareReason);
    budget -= changes.cells.length - before;
    if (budget < 1) break;
  }
  return changes;
}

export function toggleFlag(field, x, y) {
  if (!inBounds(x, y)) return { error: "bounds" };
  if (field.isRevealed(x, y)) return { error: "revealed" };
  if (field.isFlag(x, y)) {
    field.clearFlag(x, y);
    return { flag: false, x, y };
  }
  field.setFlag(x, y);
  return { flag: true, x, y };
}

function consumeStamp(stamps, now, limit, windowMs) {
  while (stamps.length && now - stamps[0] >= windowMs) stamps.shift();
  if (stamps.length >= limit) return false;
  stamps.push(now);
  return true;
}

export function refillCells(player, now) {
  if (player.cellTokenAt == null) player.cellTokenAt = now;
  if (player.cellTokens == null) player.cellTokens = START_TOKENS;
  const dt = Math.max(0, now - player.cellTokenAt);
  player.cellTokens = Math.min(CELL_CAP, player.cellTokens + (dt * CELL_PER_SEC) / 1000);
  player.cellTokenAt = now;
  return Math.floor(player.cellTokens);
}

export function checkRevealAllowed(player, now) {
  if (player.cooldownUntil > now) return { error: "cooldown", until: player.cooldownUntil };
  if (!consumeStamp(player.revealStamps, now, REVEALS_PER_SEC, 1000)) return { error: "rate" };
  const budget = refillCells(player, now);
  if (budget < 1) return { error: "rate" };
  return { max: Math.min(DEFAULT_FLOOD_MAX, budget) };
}

export function applyScore(player, result) {
  const gained = result.cells?.length || 0;
  player.clears += gained;
  player.score += gained;
  if (result.booms?.length) player.booms += 1;
}

export function attemptDig(field, player, x, y, now, opts = {}) {
  if (opts.phase === "over") return { error: "over" };
  if (opts.barred || opts.spareReason === "shield") return { error: "shield" };
  const gate = checkRevealAllowed(player, now);
  if (gate.error) return { error: gate.error, until: gate.until };
  const result = dig(field, x, y, {
    max: gate.max,
    spare: Boolean(opts.spare),
    spareReason: opts.spareReason || "",
  });
  if (!result.error) {
    player.cellTokens = Math.max(0, player.cellTokens - (result.cells?.length || 0));
    applyScore(player, result);
  }
  return result;
}

export function attemptFlag(field, player, x, y, now, opts = {}) {
  if (opts.barred) return { error: "shield" };
  if (!consumeStamp(player.flagStamps, now, FLAGS_PER_SEC, 1000)) return { error: "rate" };
  return toggleFlag(field, x, y);
}

export function freshPlayer(now = 0) {
  return {
    score: 0,
    clears: 0,
    booms: 0,
    cooldownUntil: 0,
    revealStamps: [],
    flagStamps: [],
    cellTokens: START_TOKENS,
    cellTokenAt: now,
  };
}

export function createMemoryField(seed, spec = {}) {
  const overrides = new Map(spec.overrides || []);
  const revealed = new Map(spec.revealed || []);
  const flags = new Set(spec.flags || []);

  const field = {
    seed,
    isMine(x, y) {
      const k = key(x, y);
      if (overrides.has(k)) return overrides.get(k) === 1;
      return deterministicMine(seed, x, y);
    },
    isRevealed(x, y) {
      return revealed.has(key(x, y));
    },
    isBoom(x, y) {
      return revealed.get(key(x, y)) === -1;
    },
    isFlag(x, y) {
      return flags.has(key(x, y));
    },
    numberAt(x, y) {
      const n = revealed.get(key(x, y));
      return n == null ? null : n;
    },
    setOverride(x, y, mine) {
      overrides.set(key(x, y), mine ? 1 : 0);
    },
    reveal(x, y, n) {
      flags.delete(key(x, y));
      revealed.set(key(x, y), n);
    },
    setFlag(x, y) {
      flags.add(key(x, y));
    },
    clearFlag(x, y) {
      flags.delete(key(x, y));
    },
    revealedEntries() {
      const out = [];
      for (const [k, n] of revealed) {
        const [x, y] = k.split(",").map(Number);
        out.push({ x, y, n });
      }
      return out;
    },
  };
  return field;
}

export function paint(field, x0, y0, x1, y1, mine) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) field.setOverride(x, y, mine);
  }
}
