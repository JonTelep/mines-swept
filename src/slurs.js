// Racial-slur filter. Ordinary profanity is allowed.
// The list stays in this module so the README and the UI never print it.

const TERMS = [
  "nigger",
  "nigga",
  "chink",
  "gook",
  "spic",
  "kike",
  "wetback",
  "towelhead",
  "raghead",
  "beaner",
  "coon",
  "paki",
];

const FOLD = {
  "0": "o",
  "1": "i",
  "2": "z",
  "3": "e",
  "4": "a",
  "5": "s",
  "6": "g",
  "7": "t",
  "8": "b",
  "9": "g",
  "@": "a",
  "$": "s",
  "!": "i",
  "|": "i",
  "+": "t",
  "а": "a",
  "е": "e",
  "о": "o",
  "р": "p",
  "с": "c",
  "у": "y",
  "х": "x",
  "і": "i",
  "ї": "i",
  "ё": "e",
  "κ": "k",
};

function fold(input) {
  let s = String(input).normalize("NFKD").toLowerCase();
  s = s.replace(/[\u200b\u200c\u200d\ufeff\p{M}]/gu, "");
  let out = "";
  for (const ch of s) out += FOLD[ch] ?? ch;
  return out;
}

function pattern(word) {
  const letters = [...fold(word)].filter((ch) => ch >= "a" && ch <= "z");
  const body = letters.map((ch) => `${ch}+`).join("[^a-z]{0,4}");
  return new RegExp(`(?:^|[^a-z])${body}s?(?:[^a-z]|$)`, "i");
}

const PATTERNS = TERMS.map(pattern);

export function containsSlur(input) {
  if (input == null) return false;
  const text = fold(input);
  return PATTERNS.some((re) => re.test(text));
}

function leetify(word) {
  const map = { o: "0", i: "1", e: "3", a: "4", s: "5", t: "7", g: "6" };
  return [...word].map((ch) => map[ch] || ch).join("");
}

// Used by tests so the cases are not copied into the README or the page.
export function evasionCases() {
  return TERMS.map((word) => ({
    spaced: word.split("").join(" "),
    dotted: word.split("").join("."),
    leet: leetify(word),
    repeated: word[0] + word[0] + word,
    mixed: word.split("").join("\u200b"),
    wrapped: `well ${word.split("").join("  ")} though`,
  }));
}
