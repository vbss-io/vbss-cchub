import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { countsOf, EXTRA_FILTERS, isExtraFilter, matchesFilter, type Bucket } from "./sessions-filter";

const BUCKETS: Bucket[] = ["archived", "empty", "ended", "stale", "waiting", "idle", "active", "hidden"];

describe("matchesFilter", () => {
  it("all shows only live buckets", () => {
    const shown = BUCKETS.filter((bucket) => matchesFilter("all", bucket, false));
    assert.deepEqual(shown, ["waiting", "idle", "active"]);
  });

  it("needs-you keeps live and inactive sessions that need attention", () => {
    assert.equal(matchesFilter("needs-you", "waiting", true), true);
    assert.equal(matchesFilter("needs-you", "idle", true), true);
    assert.equal(matchesFilter("needs-you", "stale", true), true);
  });

  it("needs-you drops sessions that do not need attention", () => {
    assert.equal(matchesFilter("needs-you", "idle", false), false);
    assert.equal(matchesFilter("needs-you", "active", false), false);
  });

  it("needs-you never shows ended, empty, archived or hidden sessions", () => {
    for (const bucket of ["ended", "empty", "archived", "hidden"] as const) {
      assert.equal(matchesFilter("needs-you", bucket, true), false);
    }
  });

  it("status and extra filters match their own bucket only", () => {
    assert.equal(matchesFilter("idle", "idle", false), true);
    assert.equal(matchesFilter("idle", "active", false), false);
    assert.equal(matchesFilter("active", "active", true), true);
    assert.equal(matchesFilter("waiting", "waiting", true), true);
    assert.equal(matchesFilter("ended", "ended", false), true);
    assert.equal(matchesFilter("archived", "archived", false), true);
    assert.equal(matchesFilter("stale", "stale", false), true);
    assert.equal(matchesFilter("empty", "empty", false), true);
    assert.equal(matchesFilter("archived", "ended", false), false);
  });

  it("favorites is resolved outside the bucket match", () => {
    for (const bucket of BUCKETS) assert.equal(matchesFilter("favorites", bucket, true), false);
  });

  it("never matches a hidden bucket", () => {
    for (const filter of ["all", "needs-you", "idle", "ended"] as const) assert.equal(matchesFilter(filter, "hidden", true), false);
  });
});

describe("extra filters", () => {
  it("keeps every filter that left the chip row reachable", () => {
    assert.deepEqual(
      EXTRA_FILTERS.map((item) => item.key),
      ["waiting", "ended", "stale", "empty", "archived"],
    );
  });

  it("recognises extra filters and not chip filters", () => {
    for (const item of EXTRA_FILTERS) assert.equal(isExtraFilter(item.key), true);
    for (const key of ["all", "needs-you", "active", "idle", "favorites"] as const) assert.equal(isExtraFilter(key), false);
  });

  it("pairs each option with its count", () => {
    const rows = countsOf({ waiting: 1, ended: 2, stale: 3, empty: 0, archived: 5 });
    assert.deepEqual(
      rows.map((row) => [row.key, row.count]),
      [
        ["waiting", 1],
        ["ended", 2],
        ["stale", 3],
        ["empty", 0],
        ["archived", 5],
      ],
    );
  });
});
