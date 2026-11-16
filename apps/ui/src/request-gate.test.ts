import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createLatestGate } from "./request-gate";

describe("createLatestGate", () => {
  it("keeps only the latest request current", () => {
    const gate = createLatestGate();
    const first = gate.begin("a");
    const second = gate.begin("b");
    assert.equal(first(), false);
    assert.equal(second(), true);
  });

  it("drops a late response for a task that is no longer shown", () => {
    const gate = createLatestGate();
    const forA = gate.begin("a");
    gate.show("b");
    assert.equal(forA(), false);
  });

  it("keeps a request for the shown task current until a newer one starts or it closes", () => {
    const gate = createLatestGate();
    gate.show("a");
    const load = gate.begin("a");
    assert.equal(load(), true);
    gate.close();
    assert.equal(load(), false);
  });

  it("keeps an in-flight load when the same task is shown again", () => {
    const gate = createLatestGate();
    const load = gate.begin("a");
    gate.show("a");
    assert.equal(load(), true);
  });
});
