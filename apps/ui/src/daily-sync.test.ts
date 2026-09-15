import assert from "node:assert/strict";
import { test } from "node:test";
import type { DailyStreamEvent } from "./api";
import { decideDailyEvent, generateWriteId, rememberWriteId } from "./daily-sync";

const event = (overrides: Partial<DailyStreamEvent>): DailyStreamEvent => ({
  date: "2026-09-15",
  updatedAt: 1000,
  source: "hub",
  writeId: null,
  ...overrides,
});

test("decideDailyEvent ignores an event carrying an own writeId while dirty", () => {
  const decision = decideDailyEvent(event({ writeId: "w1" }), { ownWriteIds: new Set(["w1"]), dirty: true, saving: false });
  assert.equal(decision, "ignore");
});

test("decideDailyEvent ignores an event carrying an own writeId while clean", () => {
  const decision = decideDailyEvent(event({ writeId: "w1" }), { ownWriteIds: new Set(["w1"]), dirty: false, saving: false });
  assert.equal(decision, "ignore");
});

test("decideDailyEvent reloads a foreign hub event while clean", () => {
  const decision = decideDailyEvent(event({ source: "hub", writeId: null }), { ownWriteIds: new Set(), dirty: false, saving: false });
  assert.equal(decision, "reload");
});

test("decideDailyEvent conflicts on a foreign hub event while dirty", () => {
  const decision = decideDailyEvent(event({ source: "hub", writeId: null }), { ownWriteIds: new Set(), dirty: true, saving: false });
  assert.equal(decision, "conflict");
});

test("decideDailyEvent defers a disk event while saving", () => {
  const decision = decideDailyEvent(event({ source: "disk", writeId: null }), { ownWriteIds: new Set(), dirty: false, saving: true });
  assert.equal(decision, "defer");
});

test("decideDailyEvent reloads a disk event while clean", () => {
  const decision = decideDailyEvent(event({ source: "disk", writeId: null }), { ownWriteIds: new Set(), dirty: false, saving: false });
  assert.equal(decision, "reload");
});

test("rememberWriteId caps the tracked set at 50 entries, evicting the oldest", () => {
  const ids = new Set<string>();
  const order: string[] = [];
  for (let i = 0; i < 55; i += 1) rememberWriteId(ids, order, `w${i}`);
  assert.equal(ids.size, 50);
  assert.equal(ids.has("w0"), false);
  assert.equal(ids.has("w4"), false);
  assert.equal(ids.has("w5"), true);
  assert.equal(ids.has("w54"), true);
});

test("generateWriteId returns a non-empty string", () => {
  const id = generateWriteId();
  assert.equal(typeof id, "string");
  assert.ok(id.length > 0);
});
