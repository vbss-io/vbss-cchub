import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { appendHubSource, upsertSessionBlock, whenBrainWritesIdle, writeBrainFileAtomic, type BrainWriteOps } from "../src/second-brain.js";

const dir = mkdtempSync(join(tmpdir(), "cch-brain-atomic-"));
const BOM = String.fromCharCode(0xfeff);
const block = (id: string, line: string): string => `<!-- session:${id} START -->\n### ${id}\n- ${line}\n<!-- session:${id} END -->`;
const tmpLeftovers = (): string[] => readdirSync(dir).filter((name) => name.endsWith(".tmp"));
const loneLf = (text: string): boolean => /(^|[^\r])\n/.test(text);

const lockError = (): NodeJS.ErrnoException => Object.assign(new Error("locked"), { code: "EBUSY" });

describe("atomic second brain writes", () => {
  it("keeps the BOM and CRLF of a trail file when inserting and replacing a session block", () => {
    const file = join(dir, "2026-11-15.md");
    writeFileSync(file, `${BOM}---\r\ntype: trail\r\nupdated: 2026-11-14\r\n---\r\n\r\n# Trail\r\n\r\n## Hub\r\n\r\n- 09:00 · old\r\n`);
    upsertSessionBlock(file, "s1", "2026-11-15", block("s1", "first"));
    upsertSessionBlock(file, "s1", "2026-11-15", block("s1", "again"));
    const text = readFileSync(file, "utf8");
    assert.ok(text.startsWith(BOM));
    assert.equal(loneLf(text), false);
    assert.match(text, /updated: 2026-11-15\r\n/);
    assert.match(text, /- again\r\n<!-- session:s1 END -->\r\n\r\n## Hub\r\n/);
    assert.doesNotMatch(text, /- first/);
    assert.deepEqual(tmpLeftovers(), []);
  });

  it("keeps the BOM and CRLF when appending a hub line to a unified trail", async () => {
    const trail = join(dir, "trail");
    const file = join(trail, "2026-11-15.md");
    appendHubSource(trail, "seed", new Date(2026, 10, 15, 8, 0), { dir: trail, unified: true });
    await whenBrainWritesIdle();
    writeFileSync(file, `${BOM}${readFileSync(file, "utf8").replace(/\r?\n/g, "\r\n")}`);
    appendHubSource(trail, "next", new Date(2026, 10, 15, 8, 1), { dir: trail, unified: true });
    await whenBrainWritesIdle();
    const text = readFileSync(file, "utf8");
    assert.ok(text.startsWith(BOM));
    assert.match(text, /- 08:00 · seed\r\n- 08:01 · next\r\n$/);
    assert.equal(loneLf(text), false);
    assert.deepEqual(readdirSync(trail).filter((name) => name.endsWith(".tmp")), []);
  });

  it("writes LF files with LF and leaves no temp file", () => {
    const file = join(dir, "lf.md");
    writeFileSync(file, "# Trail\n");
    upsertSessionBlock(file, "s2", "2026-11-15", block("s2", "lf"));
    const text = readFileSync(file, "utf8");
    assert.ok(!text.includes("\r"));
    assert.match(text, /# Trail\n\n<!-- session:s2 START -->\n/);
    assert.deepEqual(tmpLeftovers(), []);
  });

  it("falls back to a copy when the rename keeps hitting a lock, and never leaves the target half written", () => {
    const target = join(dir, "locked.md");
    writeFileSync(target, "before");
    let renames = 0;
    const locked: BrainWriteOps = {
      writeFileSync,
      renameSync: () => {
        renames += 1;
        throw lockError();
      },
      copyFileSync,
      unlinkSync,
    };
    writeBrainFileAtomic(target, "after", locked);
    assert.equal(readFileSync(target, "utf8"), "after");
    assert.equal(renames, 4);
    assert.deepEqual(tmpLeftovers(), []);
    const broken: BrainWriteOps = {
      writeFileSync,
      renameSync: () => {
        throw Object.assign(new Error("disk gone"), { code: "EIO" });
      },
      copyFileSync,
      unlinkSync,
    };
    assert.throws(() => writeBrainFileAtomic(target, "lost", broken), /disk gone/);
    assert.equal(readFileSync(target, "utf8"), "after");
    assert.deepEqual(tmpLeftovers(), []);
    const real: BrainWriteOps = { writeFileSync, renameSync, copyFileSync, unlinkSync };
    writeBrainFileAtomic(target, "final", real);
    assert.equal(readFileSync(target, "utf8"), "final");
  });
});

after(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
