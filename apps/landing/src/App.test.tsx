import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";

const RELEASE_API = "https://api.github.com/repos/vbss-io/vbss-cchub/releases/latest";
const LATEST_MSI = "https://github.com/vbss-io/vbss-cchub/releases/latest/download/VBSS-CCHUB-Setup.msi";
const VERSIONED_MSI = "https://github.com/vbss-io/vbss-cchub/releases/download/v1.5.0/VBSS-CCHUB-Setup-v1.5.0.msi";

const respondWith = (body: unknown, ok = true) => {
  const fetchMock = vi.fn(() => Promise.resolve({ ok, json: () => Promise.resolve(body) }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const downloadHrefs = () =>
  screen.getAllByRole("link", { name: /^Download/ }).map((link) => link.getAttribute("href"));

const settle = async (fetchMock: ReturnType<typeof vi.fn>) => {
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
};

describe("App download links", () => {
  it("points every download button at the latest installer before the release answers", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));

    render(<App />);

    expect(screen.getByRole("link", { name: "Download" })).toHaveProperty("href", LATEST_MSI);
    expect(screen.getAllByRole("link", { name: "Download for Windows" })).toHaveLength(2);
    expect(downloadHrefs()).toEqual([LATEST_MSI, LATEST_MSI, LATEST_MSI]);
    expect(screen.queryByText(/What's new/)).toBeNull();
  });

  it("asks GitHub for the latest release once", async () => {
    const fetchMock = respondWith({});

    render(<App />);

    await settle(fetchMock);
    expect(fetchMock).toHaveBeenCalledWith(RELEASE_API);
  });

  it("shows the version and links the versioned installer when the release has it", async () => {
    respondWith({
      tag_name: "v1.5.0",
      body: "## Highlights\n- Tasks board\n-not a bullet\n- Timeline zoom  \nplain line",
      assets: [
        { name: "VBSS-CCHUB-Setup.msi", browser_download_url: LATEST_MSI },
        { name: "VBSS-CCHUB-Setup-v1.5.0.msi", browser_download_url: VERSIONED_MSI },
      ],
    });

    render(<App />);

    expect(await screen.findByRole("link", { name: "Download · v1.5.0" })).toHaveProperty("href", VERSIONED_MSI);
    expect(screen.getAllByRole("link", { name: "Download for Windows · v1.5.0" })).toHaveLength(2);
    expect(downloadHrefs()).toEqual([VERSIONED_MSI, VERSIONED_MSI, VERSIONED_MSI]);

    const summary = screen.getByText("What's new in v1.5.0");
    const notes = summary.closest("details");
    expect(notes).not.toBeNull();
    const items = within(notes as HTMLElement).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(["Tasks board", "Timeline zoom"]);
  });

  it("opens the release notes when the summary is clicked", async () => {
    respondWith({ tag_name: "v1.5.0", body: "- Tasks board" });
    const user = userEvent.setup();

    render(<App />);
    const summary = await screen.findByText("What's new in v1.5.0");
    const notes = summary.closest("details") as HTMLDetailsElement;

    expect(notes.open).toBe(false);
    await user.click(summary);
    expect(notes.open).toBe(true);
  });

  it("accepts a tag without the v prefix", async () => {
    respondWith({ tag_name: "1.6.0", body: "- Faster board" });

    render(<App />);

    expect(await screen.findByText("What's new in v1.6.0")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download · v1.6.0" })).toHaveProperty("href", LATEST_MSI);
  });

  it("falls back to the latest installer when no asset matches the version", async () => {
    respondWith({
      tag_name: "v1.5.0",
      body: "- Tasks board",
      assets: [{ name: "VBSS-CCHUB-Setup-v1.4.0.msi", browser_download_url: "https://example.test/old.msi" }],
    });

    render(<App />);

    expect(await screen.findByRole("link", { name: "Download · v1.5.0" })).toHaveProperty("href", LATEST_MSI);
    expect(downloadHrefs()).toEqual([LATEST_MSI, LATEST_MSI, LATEST_MSI]);
  });

  it("shows the version without release notes when the body is missing", async () => {
    respondWith({ tag_name: "v1.5.0" });

    render(<App />);

    expect(await screen.findByRole("link", { name: "Download · v1.5.0" })).toHaveProperty("href", LATEST_MSI);
    expect(screen.queryByText(/What's new/)).toBeNull();
  });

  it("shows the version without release notes when the body has no bullets", async () => {
    respondWith({ tag_name: "v1.5.0", body: "Bug fixes only.", assets: [] });

    render(<App />);

    expect(await screen.findByRole("link", { name: "Download · v1.5.0" })).toBeTruthy();
    expect(screen.queryByText(/What's new/)).toBeNull();
  });

  it.each([
    ["GitHub answers with an error", () => respondWith({ tag_name: "v1.5.0", body: "- Tasks board" }, false)],
    ["the release has no tag", () => respondWith({ body: "- Tasks board" })],
    ["the tag is only a v", () => respondWith({ tag_name: "v", body: "- Tasks board" })],
    ["the network fails", () => {
      const fetchMock = vi.fn(() => Promise.reject(new Error("offline")));
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }],
    ["the body is not JSON", () => {
      const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.reject(new SyntaxError("bad json")) }));
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }],
  ])("keeps the unversioned download when %s", async (_case, arrange) => {
    const fetchMock = arrange();

    render(<App />);
    await settle(fetchMock);

    expect(screen.getByRole("link", { name: "Download" })).toHaveProperty("href", LATEST_MSI);
    expect(downloadHrefs()).toEqual([LATEST_MSI, LATEST_MSI, LATEST_MSI]);
    expect(screen.queryByText(/What's new/)).toBeNull();
  });
});

describe("App content", () => {
  it("links the nav to the page sections and GitHub in a new tab", () => {
    render(<App />);

    const nav = screen.getByRole("navigation");
    const hrefs = within(nav)
      .getAllByRole("link")
      .map((link) => [link.textContent, link.getAttribute("href")]);
    expect(hrefs).toEqual([
      ["Features", "#features"],
      ["Tour", "#tour"],
      ["Get started", "#start"],
      ["GitHub", "https://github.com/vbss-io/vbss-cchub"],
      ["Download", LATEST_MSI],
    ]);
    const github = within(nav).getByRole("link", { name: "GitHub" });
    expect(github.getAttribute("target")).toBe("_blank");
    expect(github.getAttribute("rel")).toBe("noopener noreferrer");
    expect(document.getElementById("features")).not.toBeNull();
    expect(document.getElementById("tour")).not.toBeNull();
    expect(document.getElementById("start")).not.toBeNull();
  });

  it("lists every feature and tags only the opt-in ones", () => {
    render(<App />);

    const features = document.querySelectorAll("#features article.feature");
    expect(features).toHaveLength(10);
    expect(document.querySelectorAll("#features .feature__tag")).toHaveLength(4);
    const optIn = Array.from(features)
      .filter((feature) => feature.querySelector(".feature__tag")?.textContent === "opt-in")
      .map((feature) => feature.querySelector("h3")?.firstChild?.textContent);
    expect(optIn).toEqual([
      "Usage: what burns tokens",
      "Plan limits",
      "Tasks from your notes",
      "Daily note & session trail",
    ]);
    const plain = within(features[0] as HTMLElement).getByRole("heading", { level: 3 });
    expect(plain.textContent).toBe("Every session, one board");
  });

  it("alternates the tour rows and gives each screenshot its alt text", () => {
    render(<App />);

    const rows = ["usage", "flow", "tasks", "timeline", "daily"].map((id) => document.getElementById(id));
    expect(rows.map((row) => row?.className)).toEqual([
      "tour__row",
      "tour__row tour__row--flip",
      "tour__row",
      "tour__row tour__row--flip",
      "tour__row",
    ]);
    const usage = rows[0] as HTMLElement;
    expect(within(usage).getByRole("heading", { level: 3 }).textContent).toBe("Know what is left before you hit the wall.");
    expect(within(usage).getAllByRole("listitem")).toHaveLength(4);
    expect(
      within(usage).getByAltText("CCHUB usage view with plan limits for Claude and Codex and tokens per day").getAttribute("src"),
    ).toBe("/shot-usage.png");
    expect(within(rows[4] as HTMLElement).getByRole("img").getAttribute("src")).toBe("/shot-daily.png");
  });

  it("numbers the get-started steps in order", () => {
    render(<App />);

    const steps = within(document.getElementById("start") as HTMLElement).getAllByRole("listitem");
    expect(steps.map((step) => [step.querySelector(".step__n")?.textContent, step.querySelector("h3")?.textContent])).toEqual([
      ["1", "Install"],
      ["2", "Install the hooks"],
      ["3", "Connect your agents"],
    ]);
  });

  it("shows the slogans and the support links", () => {
    render(<App />);

    expect(screen.getByText("Run many. Forget none.")).toBeTruthy();
    expect(screen.getByText("Make every token count.")).toBeTruthy();
    expect(screen.getByText("Delegate, don't babysit.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Read the code" }).getAttribute("href")).toBe("https://github.com/vbss-io/vbss-cchub");
    const support = screen.getByText(/Like it\?/);
    expect(
      within(support)
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href"), link.getAttribute("target")]),
    ).toEqual([
      ["Buy me a coffee", "https://www.buymeacoffee.com/vbss.io", "_blank"],
      ["sponsor on GitHub", "https://github.com/sponsors/vbss-io", "_blank"],
    ]);

    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByRole("link", { name: "vbss.io" }).getAttribute("href")).toBe("https://vbss.io");
    expect(
      within(footer)
        .getAllByRole("link")
        .slice(1)
        .map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["GitHub", "https://github.com/vbss-io"],
      ["LinkedIn", "https://www.linkedin.com/in/vbss-io"],
      ["Buy me a coffee", "https://www.buymeacoffee.com/vbss.io"],
      ["GitHub Sponsors", "https://github.com/sponsors/vbss-io"],
    ]);
  });
});
