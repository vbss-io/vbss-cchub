import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GroupRecord } from "../types";
import { GroupManager } from "./GroupManager";

const groups: GroupRecord[] = [
  { id: "g1", name: "Work", match: "/work", position: 0 },
  { id: "g2", name: "Home", match: "/home", position: 1 },
];

const setup = (list: GroupRecord[] = groups) => {
  const handlers = { onCreate: vi.fn(), onUpdate: vi.fn(), onDelete: vi.fn(), onMove: vi.fn() };
  render(<GroupManager groups={list} {...handlers} />);
  return handlers;
};

describe("GroupManager", () => {
  it("lists a row per group with name and match inputs", () => {
    setup();
    expect((screen.getByDisplayValue("Work") as HTMLInputElement).value).toBe("Work");
    expect(screen.getByDisplayValue("/home")).toBeTruthy();
  });

  it("disables the first up and last down buttons and moves the others", async () => {
    const user = userEvent.setup();
    const handlers = setup();
    expect((screen.getByRole("button", { name: "Move Work up" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Move Home down" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Move Work down" }));
    await user.click(screen.getByRole("button", { name: "Move Home up" }));
    expect(handlers.onMove).toHaveBeenNthCalledWith(1, "g1", 1);
    expect(handlers.onMove).toHaveBeenNthCalledWith(2, "g2", -1);
  });

  it("deletes a group", async () => {
    const user = userEvent.setup();
    const handlers = setup();
    await user.click(screen.getByRole("button", { name: "Delete Home" }));
    expect(handlers.onDelete).toHaveBeenCalledWith("g2");
  });

  it("renames on blur only when the trimmed name is non-empty and changed", () => {
    const handlers = setup();
    const name = screen.getByDisplayValue("Work");
    fireEvent.change(name, { target: { value: "  Office  " } });
    fireEvent.blur(name);
    expect(handlers.onUpdate).toHaveBeenCalledWith("g1", { name: "Office" });
    handlers.onUpdate.mockClear();
    fireEvent.change(name, { target: { value: "   " } });
    fireEvent.blur(name);
    expect(handlers.onUpdate).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: "Work" } });
    fireEvent.blur(name);
    expect(handlers.onUpdate).not.toHaveBeenCalled();
  });

  it("updates the match on blur only when it changed", () => {
    const handlers = setup();
    const match = screen.getByDisplayValue("/work");
    fireEvent.blur(match);
    expect(handlers.onUpdate).not.toHaveBeenCalled();
    fireEvent.change(match, { target: { value: " /office " } });
    fireEvent.blur(match);
    expect(handlers.onUpdate).toHaveBeenCalledWith("g1", { match: "/office" });
  });

  it("creates a group from the add row, trimming values and clearing the inputs", async () => {
    const user = userEvent.setup();
    const handlers = setup([]);
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(handlers.onCreate).not.toHaveBeenCalled();
    await user.type(screen.getByPlaceholderText("group name"), "  Play ");
    await user.type(screen.getByPlaceholderText("path fragment (cwd)"), " /play ");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(handlers.onCreate).toHaveBeenCalledWith("Play", "/play");
    expect((screen.getByPlaceholderText("group name") as HTMLInputElement).value).toBe("");
    expect((screen.getByPlaceholderText("path fragment (cwd)") as HTMLInputElement).value).toBe("");
  });
});
