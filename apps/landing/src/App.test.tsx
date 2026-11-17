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

const RELEASES_URL = "https://github.com/vbss-io/vbss-cchub/releases/latest";

const whatsNew = () => screen.getByRole("region", { name: "What's new" });

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
    expect(whatsNew().getAttribute("aria-busy")).toBe("true");
    expect(within(whatsNew()).queryAllByRole("listitem")).toHaveLength(0);
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

    expect(within(whatsNew()).getByText("v1.5.0")).toBeTruthy();
    const items = within(whatsNew()).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(["Tasks board", "Timeline zoom"]);
  });

  it("expands the release notes in the What's new card", async () => {
    respondWith({ tag_name: "v2.0.0", body: ["- Plugins: on or off", "- Sessions: one place", "- Today: the note", "- Search", "- Routines: scheduled"].join("\n") });
    const user = userEvent.setup();

    render(<App />);
    const toggle = await screen.findByRole("button", { name: "Show all 5 changes" });
    expect(within(whatsNew()).getAllByRole("listitem")).toHaveLength(4);

    await user.click(toggle);

    expect(within(whatsNew()).getAllByRole("listitem")).toHaveLength(5);
    expect(within(whatsNew()).getByText("Routines").tagName).toBe("STRONG");
  });

  it("accepts a tag without the v prefix", async () => {
    respondWith({ tag_name: "1.6.0", body: "- Faster board" });

    render(<App />);

    expect(await screen.findByText("v1.6.0")).toBeTruthy();
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
    expect(within(whatsNew()).getByText(/release notes on GitHub/)).toBeTruthy();
  });

  it("shows the version without release notes when the body has no bullets", async () => {
    respondWith({ tag_name: "v1.5.0", body: "Bug fixes only.", assets: [] });

    render(<App />);

    expect(await screen.findByRole("link", { name: "Download · v1.5.0" })).toBeTruthy();
    expect(within(whatsNew()).queryAllByRole("listitem")).toHaveLength(0);
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
    expect(whatsNew().getAttribute("aria-busy")).toBe("false");
    expect(within(whatsNew()).getByText(/release notes on GitHub/)).toBeTruthy();
    expect(within(whatsNew()).getByRole("link", { name: /Full release notes/ }).getAttribute("href")).toBe(RELEASES_URL);
  });
});

describe("App content", () => {
  it("draws the glow and particle background behind the page without exposing it", () => {
    const { container } = render(<App />);

    const ambient = container.querySelector(".ambient");
    expect(ambient?.getAttribute("aria-hidden")).toBe("true");
    expect(ambient?.querySelectorAll(".ambient__track .blob")).toHaveLength(10);
    expect(ambient?.querySelector("canvas.particles")).not.toBeNull();
    expect(HTMLCanvasElement.prototype.getContext).toHaveBeenCalledWith("2d");
  });

  it("links the nav to the page sections and GitHub in a new tab", () => {
    render(<App />);

    const nav = screen.getByRole("navigation");
    const hrefs = within(nav)
      .getAllByRole("link")
      .map((link) => [link.textContent, link.getAttribute("href")]);
    expect(hrefs).toEqual([
      ["Features", "#features"],
      ["Plugins", "#plugins"],
      ["Tour", "#tour"],
      ["Get started", "#start"],
      ["GitHub", "https://github.com/vbss-io/vbss-cchub"],
      ["Download", LATEST_MSI],
    ]);
    const github = within(nav).getByRole("link", { name: "GitHub" });
    expect(github.getAttribute("target")).toBe("_blank");
    expect(github.getAttribute("rel")).toBe("noopener noreferrer");
    expect(document.getElementById("features")).not.toBeNull();
    expect(document.getElementById("plugins")).not.toBeNull();
    expect(document.getElementById("tour")).not.toBeNull();
    expect(document.getElementById("start")).not.toBeNull();
  });

  it("lists the features", () => {
    render(<App />);

    const titles = Array.from(document.querySelectorAll("#features article.feature h3")).map((title) => title.textContent);
    expect(titles).toEqual([
      "Every session, one place",
      "Approve without switching windows",
      "Pick up where you left off",
      "Routines and review",
      "See the limit coming",
      "Calm, healthy, safe",
    ]);
  });

  it("presents every plugin with an icon, a purpose and its capabilities", () => {
    render(<App />);

    const plugins = within(document.getElementById("plugins") as HTMLElement);
    const cards = Array.from(document.querySelectorAll("#plugins li.plugin"));
    expect(cards.map((item) => item.querySelector("h3")?.textContent)).toEqual([
      "Sessions",
      "Today",
      "Tasks",
      "Flow",
      "Delegated",
      "Usage",
      "Limits",
      "Workspaces",
      "Reports",
      "Share",
      "Session trail",
      "Widget",
    ]);
    expect(cards.every((item) => item.querySelector(".plugin__icon svg[aria-hidden='true']") !== null)).toBe(true);
    expect(cards.every((item) => item.querySelectorAll(".plugin__points li").length >= 2)).toBe(true);
    expect(cards.filter((item) => item.querySelector(".plugin__tag")).map((item) => item.querySelector("h3")?.textContent)).toEqual(["Sessions"]);
    expect(plugins.getByText(/Settings › Plugins, then arrange/)).toBeTruthy();
    expect(plugins.getByText("A forecast of when the current window runs out")).toBeTruthy();
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
      within(usage).getByAltText("CCHUB usage view with Claude and Codex plan limits, a forecast of when the 5-hour window runs out and tokens per day").getAttribute("src"),
    ).toBe("/shot-usage.png");
    expect(within(rows[4] as HTMLElement).getByRole("img").getAttribute("src")).toBe("/shot-daily.png");
  });

  it("numbers the get-started steps in order", () => {
    render(<App />);

    const steps = within(document.getElementById("start") as HTMLElement).getAllByRole("listitem");
    expect(steps.map((step) => [step.querySelector(".step__n")?.textContent, step.querySelector("h3")?.textContent])).toEqual([
      ["1", "Install"],
      ["2", "Connect your agents"],
      ["3", "Pick your plugins"],
    ]);
  });

  it("shows the slogans and the support links", () => {
    render(<App />);

    expect(screen.getByText("Run many. Forget none.")).toBeTruthy();
    expect(screen.getByText("Approve from anywhere.")).toBeTruthy();
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
