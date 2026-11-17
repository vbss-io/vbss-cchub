import { expect, test } from "vitest";
import type { ShareRecord } from "./delegation";
import { shareAboutUrl, sharePrompt } from "./share-prompt";

const share = (trust: ShareRecord["trust"]): ShareRecord => ({ trust, workspace: "vbss" }) as unknown as ShareRecord;

test("shareAboutUrl appends /about before the query string when there is one", () => {
  expect(shareAboutUrl("https://hub.example/s/abc")).toBe("https://hub.example/s/abc/about");
  expect(shareAboutUrl("https://hub.example/s/abc?k=1&t=2")).toBe("https://hub.example/s/abc/about?k=1&t=2");
});

test("sharePrompt names the link, the about URL, the workspace and ends with an open task line", () => {
  const lines = sharePrompt(share("low"), "https://hub.example/s/abc?k=1").split("\n");
  expect(lines[0]).toBe("I'm sharing a CC Hub link so you can help me. Link: https://hub.example/s/abc?k=1");
  expect(lines[1]).toContain("GET https://hub.example/s/abc/about?k=1 first");
  expect(lines[3]).toBe("Answers come from the owner's Claude, which has the \"vbss\" workspace open and sees every request.");
  expect(lines[4]).toBe("Task: ");
});

test("sharePrompt describes every trust level", () => {
  const trustLine = (trust: ShareRecord["trust"]): string => sharePrompt(share(trust), "https://h/s").split("\n")[2] ?? "";
  expect(trustLine("low")).toBe("Trust is read-only (answers and plans only, nothing is edited).");
  expect(trustLine("medium")).toBe("Trust is edits (files in the workspace, no shell).");
  expect(trustLine("high")).toBe("Trust is edits + shell (edits and runs safe commands).");
  expect(trustLine("total")).toBe("Trust is total (no blocks).");
});
