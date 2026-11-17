import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionsModeSwitch } from "./SessionsModeSwitch";

describe("SessionsModeSwitch", () => {
  it("offers List and Search, hides Flow when it is off, and marks the active mode", () => {
    render(<SessionsModeSwitch mode="search" flowOn={false} onMode={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Flow" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Routines/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Search" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "List" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("switches mode on click and shows Flow and Routines when enabled", () => {
    const onMode = vi.fn();
    render(<SessionsModeSwitch mode="list" flowOn delegatedOn routineUnread={3} onMode={onMode} />);
    fireEvent.click(screen.getByRole("button", { name: "Flow" }));
    expect(onMode).toHaveBeenLastCalledWith("map");
    fireEvent.click(screen.getByRole("button", { name: /Routines/ }));
    expect(onMode).toHaveBeenLastCalledWith("routines");
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("hides the unread count when there is nothing unread", () => {
    render(<SessionsModeSwitch mode="routines" flowOn={false} delegatedOn routineUnread={0} onMode={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Routines" }).querySelector(".pill__count")).toBeNull();
  });
});
