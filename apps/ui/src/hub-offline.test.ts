import assert from "node:assert/strict";
import { test } from "node:test";
import { initialOfflineState, isProbing, justRecovered, OFFLINE_THRESHOLD_MS, reduceOffline, type OfflineEvent, type OfflineState } from "./hub-offline";

const run = (events: OfflineEvent[], start: OfflineState = initialOfflineState): OfflineState => events.reduce((state, event) => reduceOffline(state, event), start);

test("starts online", () => {
  assert.equal(initialOfflineState.offline, false);
  assert.equal(isProbing(initialOfflineState), false);
});

test("stream error alone never goes offline", () => {
  const state = run([
    { type: "stream-error", at: 0 },
    { type: "tick", at: OFFLINE_THRESHOLD_MS * 4 },
  ]);
  assert.equal(state.offline, false);
  assert.equal(isProbing(state), true);
});

test("failed health alone never goes offline", () => {
  const state = run([
    { type: "health-failed", at: 0 },
    { type: "tick", at: OFFLINE_THRESHOLD_MS * 4 },
  ]);
  assert.equal(state.offline, false);
});

test("stream error plus failed health goes offline only after the threshold", () => {
  const early = run([
    { type: "stream-error", at: 1000 },
    { type: "health-failed", at: 1500 },
    { type: "tick", at: 1000 + OFFLINE_THRESHOLD_MS - 1 },
  ]);
  assert.equal(early.offline, false);
  const late = reduceOffline(early, { type: "tick", at: 1000 + OFFLINE_THRESHOLD_MS });
  assert.equal(late.offline, true);
  assert.equal(late.since, 1000);
});

test("threshold counts from the first failure signal", () => {
  const state = run([
    { type: "health-failed", at: 100 },
    { type: "stream-error", at: 4000 },
    { type: "health-failed", at: 100 + OFFLINE_THRESHOLD_MS },
  ]);
  assert.equal(state.since, 100);
  assert.equal(state.offline, true);
});

test("successful health hides the banner immediately", () => {
  const offline = run([
    { type: "stream-error", at: 0 },
    { type: "health-failed", at: 0 },
    { type: "tick", at: 6000 },
  ]);
  assert.equal(offline.offline, true);
  const recovered = reduceOffline(offline, { type: "health-ok", at: 6100 });
  assert.deepEqual(recovered, initialOfflineState);
  assert.equal(justRecovered(offline, recovered), true);
});

test("reopened stream also resets", () => {
  const offline = run([
    { type: "stream-error", at: 0 },
    { type: "health-failed", at: 0 },
    { type: "tick", at: 9000 },
  ]);
  const recovered = reduceOffline(offline, { type: "stream-open", at: 9100 });
  assert.equal(recovered.offline, false);
  assert.equal(justRecovered(offline, recovered), true);
});

test("a blip that recovers before the threshold never shows the banner", () => {
  const blip = run([
    { type: "stream-error", at: 0 },
    { type: "health-failed", at: 100 },
    { type: "stream-open", at: 2000 },
    { type: "tick", at: 10_000 },
  ]);
  assert.equal(blip.offline, false);
  assert.equal(justRecovered(initialOfflineState, blip), false);
});

test("a new outage after recovery restarts the clock", () => {
  const state = run([
    { type: "stream-error", at: 0 },
    { type: "health-failed", at: 0 },
    { type: "health-ok", at: 1000 },
    { type: "stream-error", at: 20_000 },
    { type: "health-failed", at: 20_000 },
    { type: "tick", at: 20_000 + OFFLINE_THRESHOLD_MS - 1 },
  ]);
  assert.equal(state.offline, false);
  assert.equal(state.since, 20_000);
});

test("custom threshold is honoured", () => {
  const state = [
    { type: "stream-error", at: 0 },
    { type: "health-failed", at: 0 },
    { type: "tick", at: 1000 },
  ].reduce((current, event) => reduceOffline(current, event as OfflineEvent, 1000), initialOfflineState);
  assert.equal(state.offline, true);
});
