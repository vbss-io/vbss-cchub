import { afterEach, expect, test, vi } from "vitest";
import { copyText } from "./memory-clipboard";

afterEach(() => {
  vi.unstubAllGlobals();
});

const stubClipboard = (writeText: (text: string) => Promise<void>): void => {
  vi.stubGlobal("navigator", { clipboard: { writeText } });
};

test("copyText writes to the clipboard and reports success", async () => {
  const writeText = vi.fn(async (_text: string) => undefined);
  stubClipboard(writeText);
  await expect(copyText("hello")).resolves.toBe(true);
  expect(writeText).toHaveBeenCalledWith("hello");
});

test("copyText reports failure when the clipboard rejects", async () => {
  stubClipboard(() => Promise.reject(new Error("denied")));
  await expect(copyText("hello")).resolves.toBe(false);
});

test("copyText reports failure when there is no clipboard", async () => {
  vi.stubGlobal("navigator", {});
  await expect(copyText("hello")).resolves.toBe(false);
});
