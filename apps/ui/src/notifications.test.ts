import assert from "node:assert/strict";
import { test } from "node:test";
import { buildNotification, createNotifier, type FiredEvent, type NotifEventConfig } from "./notifications";
import type { SoundKind } from "./notify";

interface Harness {
  config: NotifEventConfig;
  sent: { title: string; body: string }[];
  sounds: SoundKind[];
  fired: FiredEvent[];
  clock: { value: number };
}

function harness(overrides: Partial<NotifEventConfig> = {}): Harness & { notify: ReturnType<typeof createNotifier>["notifyEvent"] } {
  const state: Harness = {
    config: {
      enabled: true,
      desktop: true,
      sound: true,
      events: {
        sessionNeedsYou: true,
        sessionFinished: true,
        taskCompleted: true,
        taskFailed: true,
        taskNeedsYou: true,
        shareAsk: true,
        shareImplement: true,
      },
      ...overrides,
    },
    sent: [],
    sounds: [],
    fired: [],
    clock: { value: 1_000 },
  };
  const { notifyEvent } = createNotifier({
    getConfig: () => state.config,
    send: (title, body) => void state.sent.push({ title, body }),
    sound: (kind) => void state.sounds.push(kind),
    now: () => state.clock.value,
    onFired: (record) => state.fired.push(record),
  });
  return { ...state, notify: notifyEvent };
}

test("fires once and routes to desktop + sound", () => {
  const h = harness();
  h.notify("taskCompleted", { id: "t1", title: "Build", detail: "done" });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sounds.length, 1);
  assert.equal(h.sounds[0], "finished");
  assert.equal(h.fired.length, 1);
  assert.equal(h.sent[0]?.title, "Delegated task finished · Build");
});

test("dedupes same kind+id within 30s", () => {
  const h = harness();
  h.notify("taskCompleted", { id: "t1", title: "Build", detail: "a" });
  h.clock.value += 29_000;
  h.notify("taskCompleted", { id: "t1", title: "Build", detail: "a" });
  assert.equal(h.fired.length, 1);
  h.clock.value += 2_000;
  h.notify("taskCompleted", { id: "t1", title: "Build", detail: "a" });
  assert.equal(h.fired.length, 2);
});

test("a repeated completed for the same task does not re-fire", () => {
  const h = harness();
  h.notify("taskCompleted", { id: "t2", title: "X", detail: null });
  h.notify("taskCompleted", { id: "t2", title: "X", detail: null });
  assert.equal(h.fired.length, 1);
});

test("distinct ids each fire", () => {
  const h = harness();
  h.notify("taskCompleted", { id: "a", title: "A", detail: null });
  h.notify("taskCompleted", { id: "b", title: "B", detail: null });
  assert.equal(h.fired.length, 2);
});

test("master switch off blocks everything", () => {
  const h = harness({ enabled: false });
  h.notify("taskCompleted", { id: "t1", title: "Build", detail: "x" });
  assert.equal(h.fired.length, 0);
  assert.equal(h.sent.length, 0);
});

test("a disabled event does not fire", () => {
  const h = harness({
    events: {
      sessionNeedsYou: true,
      sessionFinished: false,
      taskCompleted: false,
      taskFailed: true,
      taskNeedsYou: true,
      shareAsk: true,
      shareImplement: true,
    },
  });
  h.notify("taskCompleted", { id: "t1", title: "Build", detail: "x" });
  assert.equal(h.fired.length, 0);
});

test("channel toggles gate desktop and sound independently", () => {
  const desktopOnly = harness({ sound: false });
  desktopOnly.notify("taskFailed", { id: "t1", title: "Build", detail: "boom" });
  assert.equal(desktopOnly.sent.length, 1);
  assert.equal(desktopOnly.sounds.length, 0);

  const soundOnly = harness({ desktop: false });
  soundOnly.notify("taskFailed", { id: "t1", title: "Build", detail: "boom" });
  assert.equal(soundOnly.sent.length, 0);
  assert.equal(soundOnly.sounds.length, 1);
});

test("buildNotification shapes each kind", () => {
  assert.equal(buildNotification("sessionNeedsYou", { id: "s", name: "web", detail: "needs a decision" }).title, "Session needs you · web");
  assert.equal(buildNotification("sessionFinished", { id: "s", name: "web" }).body, "web");
  assert.equal(buildNotification("taskNeedsYou", { id: "t", title: "Job", detail: "why line\nsecond" }).body, "why line");
  const ask = buildNotification("shareAsk", { id: "r", label: "Gabi", asker: "Gabi", detail: "how do I run it?\nmore" });
  assert.equal(ask.title, "Ask on share Gabi");
  assert.equal(ask.body, "Gabi: how do I run it?");
});
