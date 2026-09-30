import assert from "node:assert/strict";
import { test } from "node:test";
import { deterministicMine, inBounds, setActiveSize, boardSpan } from "../src/game.js";
import {
  decodeSparse,
  encodeSparse,
  maxMapBytes,
  resolveBoardSize,
  roundWon,
  safeCells,
  summarize,
} from "../src/overview.js";
import { winLine } from "../src/round.js";

test("the board is a closed 1,000 square and the outside does not exist", () => {
  setActiveSize(1000);
  assert.equal(boardSpan(), 1000);
  assert.equal(inBounds(0, 0), true);
  assert.equal(inBounds(999, 999), true);
  assert.equal(inBounds(-1, 0), false);
  assert.equal(inBounds(0, -1), false);
  assert.equal(inBounds(1000, 500), false);
  assert.equal(inBounds(500, 1000), false);
  assert.equal(deterministicMine(1, -3, 4), false);
  assert.equal(deterministicMine(1, 1000, 0), false);
  assert.equal(resolveBoardSize("nope"), 1000);
  assert.equal(resolveBoardSize(16), 16);
  assert.equal(resolveBoardSize(12), 1000);
});

test("a round is won only when every safe cell is open", () => {
  assert.equal(safeCells(10, 3), 97);
  assert.equal(roundWon(96, 97), false);
  assert.equal(roundWon(97, 97), true);
  assert.equal(roundWon(98, 97), true);
  assert.equal(roundWon(0, 0), false);
  const line = winLine({
    round: 4,
    durationMs: (2 * 3600 + 11 * 60) * 1000,
    cleared: 825000,
    leader: { name: "Ada", clears: 12400 },
  });
  assert.equal(
    line,
    "The field is clear. Round #4 lasted 2h 11m 0s, 825,000 safe cells. Ada led with 12,400.",
  );
});

test("the overview summary is a handful of bins, not one record per cell", () => {
  const cells = [
    { x: 0, y: 0, k: "n" },
    { x: 1, y: 0, k: "f" },
    { x: 3, y: 1, k: "n" },
    { x: 9, y: 8, k: "m" },
    { x: -1, y: 0, k: "n" },
    { x: 100, y: 0, k: "n" },
  ];
  const summary = summarize(cells, 16);
  assert.equal(summary.n, 2);
  assert.equal(summary.rev[0], 2);
  assert.equal(summary.flag[0], 1);
  assert.equal(summary.blast[0], 0);
  const blast = Math.floor(8 / 8) * 2 + Math.floor(9 / 8);
  assert.equal(summary.blast[blast], 1);
  assert.equal(summary.rev[blast], 1);
  const encoded = encodeSparse(summary);
  const decoded = decodeSparse(encoded);
  assert.equal(decoded.length, 2);
  assert.ok(encoded.length < 80);
  assert.equal(maxMapBytes(1000), 125 * 125 * 5);
  assert.ok(maxMapBytes(1000) < 100_000);
});
