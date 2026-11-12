import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  loadRecents,
  normalizeText,
  PALETTE_RECENTS_KEY,
  PALETTE_RESULT_CAP,
  pushRecent,
  rankItems,
  saveRecents,
  type PaletteItem,
  type PaletteKind,
} from "./palette-model";

const item = (id: string, title: string, kind: PaletteKind = "command", extra: Partial<PaletteItem> = {}): PaletteItem => ({
  id,
  kind,
  title,
  run: () => undefined,
  ...extra,
});

const ids = (items: PaletteItem[]) => items.map((entry) => entry.id);

const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
};

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

const stubStorage = (value: unknown) => {
  Object.defineProperty(globalThis, "localStorage", { value, configurable: true, writable: true });
};

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("normalizeText", () => {
  it("strips diacritics and lowercases", () => {
    assert.equal(normalizeText("Análise Revisão"), "analise revisao");
  });
});

describe("rankItems ranking", () => {
  it("exact beats prefix beats word start beats substring beats subsequence", () => {
    const items = [
      item("subseq", "Bac kup now"),
      item("substr", "Rebackup"),
      item("word", "Run backup"),
      item("prefix", "Backups panel"),
      item("exact", "Backup"),
    ];
    assert.deepEqual(ids(rankItems(items, "backup", [])), ["exact", "prefix", "word", "substr", "subseq"]);
  });

  it("subsequence matches loosely but needs every character in order", () => {
    const items = [item("a", "Plan today"), item("b", "Toggle theme")];
    assert.deepEqual(ids(rankItems(items, "pltd", [])), ["a"]);
    assert.deepEqual(ids(rankItems(items, "dtp", [])), []);
  });

  it("prefix outranks a later subsequence hit regardless of order", () => {
    const items = [item("late", "Open settings"), item("early", "Settings")];
    assert.equal(ids(rankItems(items, "set", []))[0], "early");
  });

  it("word-start bonus beats mid-word substring", () => {
    const items = [item("mid", "Unplanned"), item("word", "Daily plan")];
    assert.deepEqual(ids(rankItems(items, "plan", [])), ["word", "mid"]);
  });

  it("ties keep input order", () => {
    const items = [item("one", "Alpha"), item("two", "Alpha")];
    assert.deepEqual(ids(rankItems(items, "alpha", [])), ["one", "two"]);
  });

  it("multiple tokens must all match, in any order", () => {
    const items = [item("a", "Refresh daily"), item("b", "Refresh sessions"), item("c", "Daily plan")];
    assert.deepEqual(ids(rankItems(items, "daily refresh", [])), ["a"]);
  });

  it("recent items get a small boost on equal matches", () => {
    const items = [item("a", "Task alpha", "task"), item("b", "Task beta", "task")];
    assert.deepEqual(ids(rankItems(items, "task", ["b"])), ["b", "a"]);
  });
});

describe("rankItems diacritics", () => {
  it("plain query matches accented title", () => {
    const items = [item("a", "Análise de custos", "task"), item("b", "Revisão do PR", "task")];
    assert.deepEqual(ids(rankItems(items, "analise", [])), ["a"]);
    assert.deepEqual(ids(rankItems(items, "revisao", [])), ["b"]);
  });

  it("accented query matches plain title", () => {
    const items = [item("a", "Analise", "task")];
    assert.deepEqual(ids(rankItems(items, "Análise", [])), ["a"]);
  });
});

describe("rankItems fields", () => {
  it("keywords are searched", () => {
    const items = [item("theme", "Toggle theme", "command", { keywords: ["dark", "midnight", "appearance"] })];
    assert.deepEqual(ids(rankItems(items, "midnight", [])), ["theme"]);
  });

  it("subtitle is searched but ranks below a title hit", () => {
    const items = [
      item("sub", "Fix login", "session", { subtitle: "vbss-cchub" }),
      item("title", "vbss-cchub", "workspace"),
    ];
    assert.deepEqual(ids(rankItems(items, "vbss-cchub", [])), ["title", "sub"]);
  });

  it("no match returns empty", () => {
    assert.deepEqual(rankItems([item("a", "Alpha")], "zzz", []), []);
  });
});

describe("rankItems empty query", () => {
  const items = [
    item("s1", "Session one", "session"),
    item("c1", "New task", "command"),
    item("v1", "Sessions", "view"),
    item("t1", "Task one", "task"),
    item("c2", "Toggle theme", "command"),
  ];

  it("recents first in recency order then commands and views", () => {
    assert.deepEqual(ids(rankItems(items, "", ["t1", "c2"])), ["t1", "c2", "c1", "v1"]);
  });

  it("without recents lists only commands and views", () => {
    assert.deepEqual(ids(rankItems(items, "   ", [])), ["c1", "v1", "c2"]);
  });

  it("recents that no longer exist are skipped", () => {
    assert.deepEqual(ids(rankItems(items, "", ["gone", "s1"])), ["s1", "c1", "v1", "c2"]);
  });
});

describe("rankItems cap", () => {
  const many = Array.from({ length: 120 }, (_, index) => item(`i${index}`, `Item ${index}`));

  it("caps at the default", () => {
    assert.equal(rankItems(many, "item", []).length, PALETTE_RESULT_CAP);
    assert.equal(rankItems(many, "", []).length, PALETTE_RESULT_CAP);
  });

  it("honors an explicit cap", () => {
    assert.equal(rankItems(many, "item", [], 5).length, 5);
  });
});

describe("pushRecent", () => {
  it("puts the newest first", () => {
    assert.deepEqual(pushRecent(["a", "b"], "c"), ["c", "a", "b"]);
  });

  it("dedupes by moving to the front", () => {
    assert.deepEqual(pushRecent(["a", "b", "c"], "c"), ["c", "a", "b"]);
  });

  it("limits to max, default 8", () => {
    const base = ["1", "2", "3", "4", "5", "6", "7", "8"];
    assert.deepEqual(pushRecent(base, "9"), ["9", "1", "2", "3", "4", "5", "6", "7"]);
    assert.deepEqual(pushRecent(base, "9", 3), ["9", "1", "2"]);
  });

  it("does not mutate the input", () => {
    const base = ["a"];
    pushRecent(base, "b");
    assert.deepEqual(base, ["a"]);
  });
});

describe("recents storage", () => {
  it("round-trips", () => {
    stubStorage(memoryStorage());
    saveRecents(["a", "b"]);
    assert.deepEqual(loadRecents(), ["a", "b"]);
  });

  it("ignores corrupt or wrongly typed data", () => {
    const storage = memoryStorage();
    stubStorage(storage);
    storage.setItem(PALETTE_RECENTS_KEY, "{not json");
    assert.deepEqual(loadRecents(), []);
    storage.setItem(PALETTE_RECENTS_KEY, JSON.stringify({ a: 1 }));
    assert.deepEqual(loadRecents(), []);
    storage.setItem(PALETTE_RECENTS_KEY, JSON.stringify(["a", 3, null, "b"]));
    assert.deepEqual(loadRecents(), ["a", "b"]);
  });

  it("survives storage that throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    stubStorage(throwing);
    assert.deepEqual(loadRecents(), []);
    assert.doesNotThrow(() => saveRecents(["a"]));
  });

  it("survives a missing localStorage", () => {
    stubStorage(undefined);
    assert.deepEqual(loadRecents(), []);
    assert.doesNotThrow(() => saveRecents(["a"]));
  });
});
