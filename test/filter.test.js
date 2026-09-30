import assert from "node:assert/strict";
import { test } from "node:test";
import { checkChatRate, CHAT_MAX, CHAT_MS, prepareChat } from "../src/chat.js";
import { clock, formatDuration, shameLine, spareReason, GRACE_MS } from "../src/round.js";
import { containsSlur, evasionCases } from "../src/slurs.js";

test("slur filter catches spacing, leetspeak, repeats, symbols, and zero-width characters", () => {
  const cases = evasionCases();
  assert.ok(cases.length >= 8);
  for (const sample of cases) {
    assert.equal(containsSlur(sample.spaced), true);
    assert.equal(containsSlur(sample.dotted), true);
    assert.equal(containsSlur(sample.leet), true);
    assert.equal(containsSlur(sample.repeated), true);
    assert.equal(containsSlur(sample.mixed), true);
    assert.equal(containsSlur(sample.wrapped), true);
  }
});

test("ordinary profanity and lookalike words are allowed", () => {
  for (const ok of ["damn", "shit", "hell", "crap", "ass", "stupid", "raccoon", "spice", "classic", "pakistan", "hello there"]) {
    assert.equal(containsSlur(ok), false, ok);
  }
});

test("chat rate limit and length", () => {
  assert.equal(checkChatRate(0, 1_000), true);
  assert.equal(checkChatRate(1_000, 1_000 + CHAT_MS - 1), false);
  assert.equal(checkChatRate(1_000, 1_000 + CHAT_MS), true);

  assert.equal(prepareChat("   ").error, "chat");
  assert.equal(prepareChat("hello").body, "hello");
  assert.equal(prepareChat("a".repeat(CHAT_MAX + 40)).body.length, CHAT_MAX);
  assert.equal(prepareChat("see https://example.com").body, "see https://example.com");
  assert.equal(prepareChat("<b>hi</b>").body.includes("<"), false);
  assert.equal(prepareChat(evasionCases()[0].spaced).error, "blocked");
});

test("round grace, shield, and shame line", () => {
  const start = 10_000;
  assert.equal(spareReason(start + 1000, start, "", "ada"), "grace");
  assert.equal(spareReason(start + GRACE_MS - 1, start, "", "ada"), "grace");
  assert.equal(spareReason(start + GRACE_MS, start, "", "ada"), "");
  assert.equal(spareReason(start + GRACE_MS + 5, start, "ada", "ada"), "shield");
  assert.equal(spareReason(start + GRACE_MS + 5, start, "ada", "bea"), "");

  assert.equal(clock(18 * 60_000 + 22_000), "00:18:22");
  assert.equal(formatDuration(3 * 3600_000 + 2 * 60_000 + 1000), "3h 2m 1s");
  assert.equal(formatDuration(18 * 60_000 + 22_000), "18m 22s");
  const line = shameLine({
    name: "Tidal Owl",
    online: 43,
    round: 12,
    durationMs: 18 * 60_000 + 22_000,
    cleared: 4810,
  });
  assert.equal(line, "Tidal Owl blew it for 43 people. Round #12 lasted 18m 22s, 4,810 cells cleared.");
  assert.equal(shameLine({ name: "Ada", online: 1, round: 2, durationMs: 4000, cleared: 3 }).includes("1 person"), true);
});
