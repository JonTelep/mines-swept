// Coarse board summary. One bin is an 8×8 patch, so a 1,000×1,000
// field is 125×125 bins. Only bins that contain something are sent.

import { MINE_PER_10K, mix32 } from "./game.js";

export const BIN = 8;

export function resolveBoardSize(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 8 || n > 1000 || n % BIN !== 0) return 1000;
  return n;
}

export function countDeterministicMines(seed, size) {
  const s = seed >>> 0;
  let n = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (mix32(s, x, y) % 10000 < MINE_PER_10K) n++;
    }
  }
  return n;
}

export function roundWon(cleared, safe) {
  return safe > 0 && (cleared | 0) >= safe;
}

export function safeCells(size, mines) {
  return Math.max(0, size * size - (mines | 0));
}

export function summarize(cells, size) {
  const n = Math.ceil(size / BIN);
  const rev = new Uint8Array(n * n);
  const flag = new Uint8Array(n * n);
  const blast = new Uint8Array(n * n);
  for (const cell of cells) {
    const x = cell.x | 0;
    const y = cell.y | 0;
    if (x < 0 || y < 0 || x >= size || y >= size) continue;
    const i = (Math.floor(y / BIN) * n) + Math.floor(x / BIN);
    const kind = cell.k || (cell.kind === 3 ? "f" : cell.kind === 2 ? "m" : "n");
    if (kind === "f") flag[i] = Math.min(255, flag[i] + 1);
    else {
      rev[i] = Math.min(255, rev[i] + 1);
      if (kind === "m") blast[i] = 1;
    }
  }
  return { n, rev, flag, blast };
}

export function encodeSparse(summary) {
  const n = summary.n;
  const parts = [];
  for (let i = 0; i < n * n; i++) {
    if (!summary.rev[i] && !summary.flag[i] && !summary.blast[i]) continue;
    parts.push(i % n, (i / n) | 0, summary.rev[i], summary.flag[i], summary.blast[i]);
  }
  return bytesToB64(parts);
}

export function encodeRows(rows) {
  const parts = [];
  for (const row of rows) {
    parts.push(row.bx & 255, row.by & 255, row.revealed & 255, row.flags & 255, row.blast ? 1 : 0);
  }
  return bytesToB64(parts);
}

export function decodeSparse(b64) {
  if (!b64) return [];
  const raw = atob(b64);
  const out = [];
  for (let i = 0; i + 4 < raw.length; i += 5) {
    out.push({
      bx: raw.charCodeAt(i),
      by: raw.charCodeAt(i + 1),
      revealed: raw.charCodeAt(i + 2),
      flags: raw.charCodeAt(i + 3),
      blast: raw.charCodeAt(i + 4),
    });
  }
  return out;
}

export function maxMapBytes(size) {
  const n = Math.ceil(size / BIN);
  return n * n * 5;
}

function bytesToB64(parts) {
  if (!parts.length) return "";
  let s = "";
  for (let i = 0; i < parts.length; i++) s += String.fromCharCode(parts[i]);
  return btoa(s);
}
