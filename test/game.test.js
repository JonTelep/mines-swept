import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHUNK,
  attemptDig,
  attemptFlag,
  checkRevealAllowed,
  chunkChecksum,
  countMines,
  createMemoryField,
  deterministicMine,
  dig,
  freshPlayer,
  inBounds,
  minesInChunk,
  neighbors,
  paint,
  toggleFlag,
} from "../src/game.js";

const SEED = 0x4d696e65;

function consistent(field) {
  for (const { x, y, n } of field.revealedEntries()) {
    if (n < 0) {
      assert.equal(field.isMine(x, y), true);
      continue;
    }
    assert.equal(countMines(field, x, y), n, `number at ${x},${y}`);
    if (n === 0) {
      for (const [nx, ny] of neighbors(x, y)) {
        if (!inBounds(nx, ny)) continue;
        assert.ok(
          field.isRevealed(nx, ny) || field.isMine(nx, ny) || field.isFlag(nx, ny),
          `zero at ${x},${y} still touches a hidden safe cell`,
        );
      }
    }
  }
}

test("chunk generation is deterministic for a seed and changes with chunk or seed", () => {
  const a = minesInChunk(SEED, 0, 0);
  const b = minesInChunk(SEED, 0, 0);
  assert.deepEqual(a, b);
  assert.equal(a.length, 182);
  assert.equal(chunkChecksum(SEED, 0, 0), 219562980);
  assert.equal(chunkChecksum(SEED, -2, 3), chunkChecksum(SEED, -2, 3));
  assert.notEqual(chunkChecksum(SEED, 0, 0), chunkChecksum(SEED, 1, 0));
  assert.notEqual(chunkChecksum(SEED, 0, 0), chunkChecksum(SEED + 1, 0, 0));

  assert.equal(minesInChunk(SEED, -1, 2).length, 0);
  assert.equal(deterministicMine(SEED, -1, 0), false);
  assert.equal(inBounds(0, 0), true);
  assert.equal(inBounds(999, 999), true);
  assert.equal(inBounds(1000, 0), false);
  const edge = minesInChunk(SEED, 31, 0);
  assert.ok(edge.length > 0);
  for (const [x, y] of edge) {
    assert.ok(x >= 992 && x < 1000);
    assert.ok(y >= 0 && y < 32);
  }
});

test("flood fill opens a safe pocket and stops on numbers", () => {
  const field = createMemoryField(SEED);
  paint(field, 26, 26, 34, 34, true);
  paint(field, 29, 29, 31, 31, false);
  const result = dig(field, 30, 30);
  assert.equal(result.error, undefined);
  assert.equal(result.booms.length, 0);
  assert.equal(result.cells.length, 9);
  const center = result.cells.find((c) => c.x === 30 && c.y === 30);
  assert.equal(center.n, 0);
  const corner = result.cells.find((c) => c.x === 31 && c.y === 31);
  assert.ok(corner.n > 0);
  assert.equal(field.isRevealed(32, 32), false);
  consistent(field);
});

test("a frontier mine detonates only that cell and does not flood", () => {
  const field = createMemoryField(SEED);
  paint(field, 27, 27, 33, 33, false);
  field.setOverride(30, 30, true);
  const opened = dig(field, 31, 30);
  assert.equal(opened.booms.length, 0);
  assert.equal(field.isRevealed(31, 30), true);
  assert.equal(field.numberAt(31, 30), 1);
  const boom = dig(field, 30, 30);
  assert.equal(boom.booms.length, 1);
  assert.deepEqual(boom.booms[0], { x: 30, y: 30 });
  assert.equal(boom.cells.length, 0);
  assert.equal(field.isBoom(30, 30), true);
  assert.equal(boom.relocated, null);
  consistent(field);
});

test("a mine in untouched ground is moved instead of killing the digger", () => {
  const field = createMemoryField(1);
  paint(field, 24, 24, 36, 36, false);
  field.setOverride(30, 30, true);
  const result = dig(field, 30, 30, { max: 80 });
  assert.equal(result.booms.length, 0);
  assert.equal(field.isMine(30, 30), false);
  assert.ok(result.relocated);
  assert.equal(field.isMine(result.relocated.toX, result.relocated.toY), true);
  assert.equal(field.isRevealed(30, 30), true);
  consistent(field);
});

test("capping a huge opening seals it without lying about numbers", () => {
  const field = createMemoryField(7);
  paint(field, 18, 18, 42, 42, false);
  const result = dig(field, 30, 30, { max: 25 });
  assert.ok(result.capped);
  assert.ok(result.cells.length <= 25);
  assert.ok(result.cells.length >= 1);
  consistent(field);
});

test("flags block reveals, and a correct chord opens while a wrong one booms", () => {
  const field = createMemoryField(3);
  paint(field, 27, 27, 33, 33, false);
  field.setOverride(30, 30, true);

  toggleFlag(field, 30, 30);
  const blocked = dig(field, 30, 30);
  assert.equal(blocked.error, "flagged");
  assert.equal(field.isBoom(30, 30), false);

  const edge = dig(field, 31, 30);
  assert.equal(edge.booms.length, 0);
  assert.equal(field.numberAt(31, 30), 1);
  const flagged = toggleFlag(field, 31, 30);
  assert.equal(flagged.error, "revealed");

  const chord = dig(field, 31, 30);
  assert.equal(chord.chord, true);
  assert.equal(chord.booms.length, 0);
  assert.ok(chord.cells.length > 0);
  consistent(field);

  const field2 = createMemoryField(3);
  paint(field2, 27, 27, 33, 33, false);
  field2.setOverride(30, 30, true);
  dig(field2, 31, 30);
  toggleFlag(field2, 32, 30);
  const wrong = dig(field2, 31, 30);
  assert.ok(wrong.booms.some((b) => b.x === 30 && b.y === 30));
  consistent(field2);
});

test("server-side validation rejects bad coords, cooldown, and rate limits before the board changes", () => {
  const field = createMemoryField(9);
  assert.equal(dig(field, 1.5, 0).error, "bounds");
  assert.equal(dig(field, -1, 0).error, "bounds");
  assert.equal(dig(field, 1000, 0).error, "bounds");
  assert.equal(inBounds(0, 999), true);
  assert.equal(inBounds(-1, 0), false);
  assert.equal(toggleFlag(field, 4_000_000, 0).error, "bounds");

  const cooling = freshPlayer(0);
  cooling.cooldownUntil = 10_000;
  const denied = attemptDig(field, cooling, 0, 0, 5_000);
  assert.equal(denied.error, "cooldown");
  assert.equal(field.isRevealed(0, 0), false);

  const player = freshPlayer(1_000);
  for (let i = 0; i < 6; i++) {
    assert.equal(checkRevealAllowed(player, 1_000).error, undefined);
  }
  assert.equal(checkRevealAllowed(player, 1_000).error, "rate");

  const flags = createMemoryField(4);
  const flagger = freshPlayer(2_000);
  for (let i = 0; i < 10; i++) {
    assert.equal(attemptFlag(flags, flagger, i, 8, 2_000).error, undefined);
  }
  assert.equal(attemptFlag(flags, flagger, 3, 9, 2_000).error, "rate");
  assert.equal(flags.isFlag(3, 9), false);
});

test("a frontier mine booms that cell and does not start a personal cooldown", () => {
  const field = createMemoryField(5);
  paint(field, 28, 28, 32, 32, false);
  field.setOverride(30, 30, true);
  const player = freshPlayer(0);
  const opened = attemptDig(field, player, 31, 30, 0);
  assert.equal(opened.booms.length, 0);
  assert.equal(player.score, opened.cells.length);
  const before = player.score;
  const boom = attemptDig(field, player, 30, 30, 10);
  assert.equal(boom.booms.length, 1);
  assert.equal(player.score, before);
  assert.equal(player.booms, 1);
  assert.equal(player.clears, before);
  assert.equal(player.cooldownUntil, 0);
  consistent(field);
});

test("a spared dig moves a frontier mine instead of blowing the round", () => {
  const field = createMemoryField(5);
  paint(field, 28, 28, 32, 32, false);
  field.setOverride(30, 30, true);
  const player = freshPlayer(0);
  attemptDig(field, player, 31, 30, 0);
  const spared = attemptDig(field, player, 30, 30, 10, { spare: true, spareReason: "grace" });
  assert.equal(spared.booms.length, 0);
  assert.equal(spared.spared, "grace");
  assert.equal(field.isMine(30, 30), false);
  assert.equal(field.isRevealed(30, 30), true);
  assert.equal(player.booms, 0);
  consistent(field);
});
