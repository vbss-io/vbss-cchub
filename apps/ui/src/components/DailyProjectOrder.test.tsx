import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { boardProject } from "../test-support/u1-fixtures";
import { DailyProjectOrder } from "./DailyProjectOrder";

const projects = [boardProject("a", "Alpha"), boardProject("b", "Bravo", { depth: 1, path: "/a/b.md" }), boardProject("c", "Charlie")];

const names = (): (string | null)[] => Array.from(document.querySelectorAll(".porder__name")).map((element) => element.textContent);

describe("DailyProjectOrder", () => {
  it("shows the empty hint when there are no projects", () => {
    render(<DailyProjectOrder projects={[]} order={[]} disabled={false} onChange={vi.fn()} />);
    expect(screen.getByText(/No projects yet/)).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("lists projects in tree order with indentation and the project path as title", () => {
    render(<DailyProjectOrder projects={projects} order={[]} disabled={false} onChange={vi.fn()} />);
    expect(names()).toEqual(["Alpha", "Bravo", "Charlie"]);
    const bravo = document.querySelectorAll<HTMLElement>(".porder__name")[1];
    expect(bravo?.getAttribute("title")).toBe("/a/b.md");
    expect(bravo?.style.paddingLeft).toBe("16px");
  });

  it("follows the saved order and skips ids of unknown projects", () => {
    render(<DailyProjectOrder projects={projects} order={["c", "ghost"]} disabled={false} onChange={vi.fn()} />);
    expect(names()).toEqual(["Charlie", "Alpha", "Bravo"]);
  });

  it("moves a project up and down through onChange", () => {
    const onChange = vi.fn();
    render(<DailyProjectOrder projects={projects} order={[]} disabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Move Bravo up" }));
    expect(onChange).toHaveBeenLastCalledWith(["b", "a", "c"]);
    fireEvent.click(screen.getByRole("button", { name: "Move Bravo down" }));
    expect(onChange).toHaveBeenLastCalledWith(["a", "c", "b"]);
  });

  it("disables the first up and the last down button", () => {
    render(<DailyProjectOrder projects={projects} order={[]} disabled={false} onChange={vi.fn()} />);
    expect((screen.getByRole("button", { name: "Move Alpha up" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Move Charlie down" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Move Alpha down" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("resets to the tree order only when an order is saved", () => {
    const onChange = vi.fn();
    const { rerender } = render(<DailyProjectOrder projects={projects} order={[]} disabled={false} onChange={onChange} />);
    expect((screen.getByRole("button", { name: "Reset to tree order" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<DailyProjectOrder projects={projects} order={["c"]} disabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset to tree order" }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("disables every control while disabled", () => {
    render(<DailyProjectOrder projects={projects} order={["c"]} disabled onChange={vi.fn()} />);
    for (const button of screen.getAllByRole("button")) expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
