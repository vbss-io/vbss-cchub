import { describe, expect, it, vi } from "vitest";
import { fetchLatestRelease, releaseDate, splitHighlight } from "./release";

const RELEASES_URL = "https://github.com/vbss-io/vbss-cchub/releases/latest";

const respondWith = (body: unknown) => vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(body) })));

describe("splitHighlight", () => {
  it("uses a short lead before the colon as the title", () => {
    expect(splitHighlight("Plugins: every area is a plugin")).toEqual({ title: "Plugins", text: "Every area is a plugin" });
  });

  it("keeps the whole line when there is no short lead", () => {
    expect(splitHighlight("Open session jumps to the terminal")).toEqual({ title: null, text: "Open session jumps to the terminal" });
    expect(splitHighlight(": starts with a colon")).toEqual({ title: null, text: ": starts with a colon" });
    const long = "Approve or deny Claude and Codex permission requests from anywhere: hub, toast, widget";
    expect(splitHighlight(long)).toEqual({ title: null, text: long });
  });
});

describe("releaseDate", () => {
  it("formats a valid date in UTC and drops missing or invalid ones", () => {
    expect(releaseDate("2026-11-17T23:59:00Z")).toEqual({ iso: "2026-11-17T23:59:00Z", label: "Nov 17, 2026" });
    expect(releaseDate(null)).toBeNull();
    expect(releaseDate("")).toBeNull();
    expect(releaseDate("soon")).toBeNull();
  });
});

describe("fetchLatestRelease", () => {
  it("reads the date, the release page and titled highlights", async () => {
    respondWith({
      tag_name: "v2.0.0",
      body: "- Plugins: on or off\n- Faster board",
      html_url: "https://github.com/vbss-io/vbss-cchub/releases/tag/v2.0.0",
      published_at: "2026-11-17T12:00:00Z",
    });

    expect(await fetchLatestRelease()).toEqual({
      version: "2.0.0",
      highlights: [
        { title: "Plugins", text: "On or off" },
        { title: null, text: "Faster board" },
      ],
      downloadUrl: "https://github.com/vbss-io/vbss-cchub/releases/latest/download/VBSS-CCHUB-Setup.msi",
      publishedAt: "2026-11-17T12:00:00Z",
      url: "https://github.com/vbss-io/vbss-cchub/releases/tag/v2.0.0",
    });
  });

  it("falls back to the latest release page when the link is missing or not on GitHub", async () => {
    respondWith({ tag_name: "v2.0.0", html_url: "javascript:alert(1)" });
    expect((await fetchLatestRelease())?.url).toBe(RELEASES_URL);

    respondWith({ tag_name: "v2.0.0" });
    const latest = await fetchLatestRelease();
    expect(latest?.url).toBe(RELEASES_URL);
    expect(latest?.publishedAt).toBeNull();
  });
});
