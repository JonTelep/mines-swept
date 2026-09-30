// Anonymous sweeper identities. Stable for a given id, editable later.

export const PALETTE = [
  "#e85d4c",
  "#f0a202",
  "#7dcea0",
  "#3ec6c6",
  "#6ea8fe",
  "#c084fc",
  "#f472b6",
  "#e4b15a",
  "#fb923c",
  "#34d399",
  "#93c5fd",
  "#f9a8d4",
];

const ADJ = [
  "amber", "brass", "cobalt", "dusty", "feral", "gilded", "hollow", "iron",
  "jade", "keen", "lunar", "moss", "neon", "ochre", "quiet", "rust",
  "solar", "tidal", "velvet", "wild", "copper", "flint",
];

const NOUN = [
  "badger", "crow", "dingo", "egret", "fox", "gull", "heron", "ibis",
  "jackal", "kite", "lynx", "moth", "newt", "owl", "pika", "quail",
  "raven", "stoat", "tern", "vole", "wren", "yak",
];

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function title(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function nameFromId(id) {
  const h = hashString(String(id));
  return title(ADJ[h % ADJ.length]) + " " + title(NOUN[(h >>> 8) % NOUN.length]);
}

export function colorFromId(id) {
  return PALETTE[hashString(String(id)) % PALETTE.length];
}

export function cleanName(input) {
  if (typeof input !== "string") return null;
  const trimmed = input.replace(/[^\p{L}\p{N} _.'-]/gu, "").trim().slice(0, 18);
  if (trimmed.length < 2) return null;
  return trimmed;
}

const ID_RE = /^[A-Za-z0-9_-]{8,40}$/;

export function validPlayerId(id) {
  return typeof id === "string" && ID_RE.test(id);
}
