import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allocatePortBase,
  PORT_BLOCK_SIZE,
  PORT_RANGE_END,
  PORT_RANGE_START,
  portRangeOf,
  PortRangeExhaustedError,
} from "../src/task-ports.js";

describe("allocatePortBase", () => {
  it("picks the range start when nothing is used", () => {
    assert.equal(allocatePortBase([]), PORT_RANGE_START);
  });

  it("skips blocks already in use", () => {
    assert.equal(allocatePortBase([PORT_RANGE_START]), PORT_RANGE_START + PORT_BLOCK_SIZE);
    assert.equal(
      allocatePortBase([PORT_RANGE_START, PORT_RANGE_START + PORT_BLOCK_SIZE]),
      PORT_RANGE_START + PORT_BLOCK_SIZE * 2,
    );
  });

  it("only ever returns bases aligned to the block size", () => {
    for (let i = 0; i < 20; i += 1) {
      const used = Array.from({ length: i }, (_, index) => PORT_RANGE_START + index * PORT_BLOCK_SIZE);
      assert.equal((allocatePortBase(used) - PORT_RANGE_START) % PORT_BLOCK_SIZE, 0);
    }
  });

  it("throws once the range is exhausted", () => {
    const used: number[] = [];
    for (let base = PORT_RANGE_START; base <= PORT_RANGE_END - PORT_BLOCK_SIZE + 1; base += PORT_BLOCK_SIZE) used.push(base);
    assert.throws(() => allocatePortBase(used), PortRangeExhaustedError);
  });
});

describe("portRangeOf", () => {
  it("returns a block of PORT_BLOCK_SIZE ports starting at base", () => {
    assert.deepEqual(portRangeOf(20000), { base: 20000, end: 20009 });
    assert.deepEqual(portRangeOf(20010), { base: 20010, end: 20019 });
  });
});
