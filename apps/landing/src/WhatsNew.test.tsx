import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Highlight, LatestRelease } from "./release";
import { WhatsNew } from "./WhatsNew";

const RELEASES_URL = "https://github.com/vbss-io/vbss-cchub/releases/latest";
const TAG_URL = "https://github.com/vbss-io/vbss-cchub/releases/tag/v2.0.0";

const highlights = (count: number): Highlight[] =>
  Array.from({ length: count }, (_, index) => ({ title: index % 2 === 0 ? `Area ${index + 1}` : null, text: `change ${index + 1}` }));

const release = (overrides: Partial<LatestRelease> = {}): LatestRelease => ({
  version: "2.0.0",
  highlights: highlights(6),
  downloadUrl: "https://example.test/setup.msi",
  publishedAt: "2026-11-17T21:30:00Z",
  url: TAG_URL,
  ...overrides,
});

const card = () => screen.getByRole("region", { name: "What's new" });

describe("WhatsNew", () => {
  it("holds its place with a skeleton while the release loads", () => {
    const { container } = render(<WhatsNew state={{ status: "loading" }} />);

    expect(card().getAttribute("aria-busy")).toBe("true");
    expect(container.querySelectorAll(".whatsnew__item--ghost")).toHaveLength(4);
    expect(container.querySelector(".whatsnew__list")?.getAttribute("aria-hidden")).toBe("true");
    expect(within(card()).queryAllByRole("listitem")).toHaveLength(0);
    expect(within(card()).queryByRole("button")).toBeNull();
    expect(within(card()).queryByText(/release notes on GitHub/)).toBeNull();
    expect(within(card()).getByRole("link", { name: /Full release notes/ }).getAttribute("href")).toBe(RELEASES_URL);
  });

  it("shows the version badge, the release date and the first four changes", () => {
    render(<WhatsNew state={{ status: "ready", release: release() }} />);

    expect(card().getAttribute("aria-busy")).toBe("false");
    expect(within(card()).getByText("v2.0.0")).toBeTruthy();
    const date = within(card()).getByText("Nov 17, 2026");
    expect(date.tagName).toBe("TIME");
    expect(date.getAttribute("datetime")).toBe("2026-11-17T21:30:00Z");
    const items = within(card()).getAllByRole("listitem");
    expect(items.map((item) => item.querySelector(".whatsnew__text")?.textContent)).toEqual(["change 1", "change 2", "change 3", "change 4"]);
    expect(items.map((item) => item.querySelector(".whatsnew__label")?.textContent ?? null)).toEqual(["Area 1", null, "Area 3", null]);
    expect(items[0]?.querySelector(".whatsnew__text")?.className).toBe("whatsnew__text whatsnew__text--short");
    expect(items[1]?.querySelector(".whatsnew__text")?.className).toBe("whatsnew__text");
  });

  it("links the full release on GitHub in a new tab", () => {
    render(<WhatsNew state={{ status: "ready", release: release() }} />);

    const link = within(card()).getByRole("link", { name: /Full release notes/ });
    expect(link.getAttribute("href")).toBe(TAG_URL);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("expands to every change and collapses back", async () => {
    const user = userEvent.setup();
    render(<WhatsNew state={{ status: "ready", release: release() }} />);

    const toggle = within(card()).getByRole("button", { name: "Show all 6 changes" });
    const list = within(card()).getByRole("list");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(list.id);

    await user.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("Show fewer");
    expect(within(card()).getAllByRole("listitem")).toHaveLength(6);
    expect(within(card()).getByRole("list").className).toBe("whatsnew__list whatsnew__list--open");

    await user.click(toggle);

    expect(within(card()).getAllByRole("listitem")).toHaveLength(4);
    expect(toggle.textContent).toBe("Show all 6 changes");
  });

  it("toggles from the keyboard", async () => {
    const user = userEvent.setup();
    render(<WhatsNew state={{ status: "ready", release: release() }} />);

    const toggle = within(card()).getByRole("button");
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await user.keyboard(" ");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("has no toggle when every change already fits", () => {
    render(<WhatsNew state={{ status: "ready", release: release({ highlights: highlights(4) }) }} />);

    expect(within(card()).getAllByRole("listitem")).toHaveLength(4);
    expect(within(card()).queryByRole("button")).toBeNull();
  });

  it("points to GitHub when the release has no highlights or no valid date", () => {
    render(<WhatsNew state={{ status: "ready", release: release({ highlights: [], publishedAt: "not a date" }) }} />);

    expect(within(card()).getByText("v2.0.0")).toBeTruthy();
    expect(card().querySelector("time")).toBeNull();
    expect(within(card()).getByText("Every change in every version is listed in the release notes on GitHub.")).toBeTruthy();
  });

  it("omits the date when the release has none", () => {
    render(<WhatsNew state={{ status: "ready", release: release({ publishedAt: null }) }} />);

    expect(card().querySelector("time")).toBeNull();
  });

  it("stays a calm pointer to GitHub when the release could not load", () => {
    const { container } = render(<WhatsNew state={{ status: "failed" }} />);

    expect(card().getAttribute("aria-busy")).toBe("false");
    expect(container.querySelector(".whatsnew__badge--ghost")).toBeNull();
    expect(within(card()).getByText("Latest")).toBeTruthy();
    expect(within(card()).getByText("See what changed")).toBeTruthy();
    expect(container.querySelector(".whatsnew__item--ghost")).toBeNull();
    expect(within(card()).getByText(/release notes on GitHub/)).toBeTruthy();
    expect(within(card()).getByRole("link", { name: /Full release notes/ }).getAttribute("href")).toBe(RELEASES_URL);
  });
});
