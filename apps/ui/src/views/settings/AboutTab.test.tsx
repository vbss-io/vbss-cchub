import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { AboutTab } from "./AboutTab";
import { Advanced } from "./Advanced";

const openExternal = vi.fn(async (_url: string) => undefined);

vi.mock("../../notify", () => ({
  GITHUB_URL: "https://github.example/hub",
  COFFEE_URL: "https://coffee.example/me",
  SPONSORS_URL: "https://sponsors.example/me",
  openExternal: (url: string) => openExternal(url),
}));

vi.mock("./BackupsPanel", () => ({ BackupsPanel: () => <div data-testid="backups" /> }));

beforeEach(() => {
  openExternal.mockClear();
});

test("shows the version, the hub address and the backups panel", () => {
  render(<AboutTab hubUrl="http://127.0.0.1:4317" version="1.4.0" onWhatsNew={() => undefined} />);
  expect(screen.getByText(/v1\.4\.0/)).toBeTruthy();
  expect(screen.getByText("http://127.0.0.1:4317").tagName).toBe("CODE");
  expect(screen.getByTestId("backups")).toBeTruthy();
});

test("both What's new buttons open the changelog", async () => {
  const onWhatsNew = vi.fn();
  render(<AboutTab hubUrl="h" version="1" onWhatsNew={onWhatsNew} />);
  const buttons = screen.getAllByRole("button", { name: "What's new" });
  expect(buttons).toHaveLength(2);
  for (const button of buttons) await userEvent.click(button);
  expect(onWhatsNew).toHaveBeenCalledTimes(2);
});

test("the support buttons open the project, coffee and sponsor pages outside the app", async () => {
  render(<AboutTab hubUrl="h" version="1" onWhatsNew={() => undefined} />);
  await userEvent.click(screen.getByRole("button", { name: "GitHub" }));
  await userEvent.click(screen.getByRole("button", { name: "Buy me a coffee" }));
  await userEvent.click(screen.getByRole("button", { name: "GitHub Sponsors" }));
  expect(openExternal.mock.calls.map((call) => call[0])).toEqual(["https://github.example/hub", "https://coffee.example/me", "https://sponsors.example/me"]);
});

test("Advanced wraps its children in a collapsible section", () => {
  const { container } = render(
    <Advanced>
      <span>inner</span>
    </Advanced>,
  );
  const details = container.querySelector("details.advanced") as HTMLDetailsElement;
  expect(details.open).toBe(false);
  expect(screen.getByText("Advanced").tagName).toBe("SUMMARY");
  expect(details.querySelector(".advanced__body")?.textContent).toBe("inner");
});
