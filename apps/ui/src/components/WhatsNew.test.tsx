import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { WhatsNew } from "./WhatsNew";

test("lists the app version and every changelog entry", () => {
  render(<WhatsNew onClose={() => undefined} />);
  expect(screen.getByRole("dialog", { name: "What's new" })).toBeTruthy();
  expect(screen.getByText(`v${__APP_VERSION__}`, { selector: ".badge" })).toBeTruthy();
  const entries = document.querySelectorAll(".whatsnew__entry");
  expect(entries.length).toBe(__CHANGELOG__.length);
  const first = __CHANGELOG__[0];
  expect(first).toBeDefined();
  expect(document.querySelector(".whatsnew__entry h3")?.textContent).toContain(`v${first?.version ?? ""}`);
});

test("closes from the button and from the overlay but not from inside the dialog", async () => {
  const onClose = vi.fn();
  render(<WhatsNew onClose={onClose} />);
  await userEvent.click(screen.getByRole("dialog"));
  expect(onClose).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledTimes(1);
  const overlay = document.querySelector(".whatsnew__overlay");
  expect(overlay).not.toBeNull();
  await userEvent.click(overlay as Element);
  expect(onClose).toHaveBeenCalledTimes(2);
});
