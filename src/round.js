// Round lifetime for the shared field. Pure helpers: no storage, no sockets.

export const GRACE_MS = 20_000;
export const INTERMISSION_MS = 15_000;
export const BLAST_RADIUS = 14;

// Untouched ground is already safe in the dig rules. On top of that, a round
// cannot end during the opening grace, and the player who just blew a round
// cannot be the one to end the next one. Both cases move the mine instead.
export function spareReason(now, startedAt, shieldId, playerId) {
  if (!startedAt || now < startedAt + GRACE_MS) return "grace";
  if (shieldId && playerId === shieldId) return "shield";
  return "";
}

export function clock(ms) {
  const s = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, "0")).join(":");
}

export function formatDuration(ms) {
  const s = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function winLine({ round, durationMs, cleared, leader }) {
  const cells = Math.max(0, cleared | 0).toLocaleString("en-US");
  const led = leader?.name
    ? ` ${leader.name} led with ${Math.max(0, leader.clears | 0).toLocaleString("en-US")}.`
    : "";
  return `The field is clear. Round #${round} lasted ${formatDuration(durationMs)}, ${cells} safe cells.${led}`;
}

export function shameLine({ name, online, round, durationMs, cleared }) {
  const people = online === 1 ? "1 person" : `${Number(online) || 0} people`;
  const cells = Math.max(0, cleared | 0).toLocaleString("en-US");
  return `${name} blew it for ${people}. Round #${round} lasted ${formatDuration(durationMs)}, ${cells} cells cleared.`;
}

export function minesAround(isMine, x, y, radius = BLAST_RADIUS) {
  const out = [];
  const r2 = radius * radius;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const xx = x + dx;
      const yy = y + dy;
      if (!isMine(xx, yy)) continue;
      out.push({ x: xx, y: yy });
      if (out.length >= 220) return out;
    }
  }
  return out;
}
