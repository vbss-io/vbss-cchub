import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import type { BoardProject } from "../../delegation";
import { fullSettings } from "../../test-support/u5-fixtures";
import { TodayTab } from "./TodayTab";

const api = vi.hoisted(() => ({ getTasksBoard: vi.fn<() => Promise<unknown>>() }));

vi.mock("../../delegation", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../delegation")>()), getTasksBoard: api.getTasksBoard }));

vi.mock("../../components/DailyProjectOrder", () => ({
  DailyProjectOrder: (props: { projects: BoardProject[]; order: string[]; disabled: boolean; onChange: (order: string[]) => void }) => (
    <div data-testid="project-order" data-disabled={String(props.disabled)}>
      <span>{props.projects.map((project) => project.id).join(",")}</span>
      <span data-testid="order">{props.order.join(",")}</span>
      <button onClick={() => props.onChange(["b", "a"])}>reorder</button>
    </div>
  ),
}));

beforeEach(() => {
  api.getTasksBoard.mockReset().mockResolvedValue({ projects: [{ id: "a" }, { id: "b" }] });
});

const setup = (props: Partial<Parameters<typeof TodayTab>[0]> = {}) => {
  const onSaveSettings = vi.fn(async () => undefined);
  const view = render(<TodayTab enabled settings={fullSettings()} onSaveSettings={onSaveSettings} {...props} />);
  return { onSaveSettings, ...view };
};

const save = (): HTMLButtonElement => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
const change = (element: HTMLElement, value: string): void => void fireEvent.change(element, { target: { value } });
const headings = (): HTMLInputElement[] => [...document.querySelectorAll<HTMLInputElement>(".frow--fields input")];

test("shows the saved settings and loads the projects for ordering", async () => {
  setup();
  expect((screen.getByPlaceholderText("D:/vault/daily") as HTMLInputElement).value).toBe("daily");
  expect((screen.getByPlaceholderText("_templates/daily.md") as HTMLInputElement).value).toBe("");
  expect(headings().map((input) => input.value)).toEqual(["Focus", "Meetings", "Sessions"]);
  expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("claude");
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  expect(save().disabled).toBe(true);
  expect((await screen.findByTestId("project-order")).textContent).toContain("a,b");
});

test("without settings the form uses defaults and the project list stays empty when the board fails", async () => {
  api.getTasksBoard.mockRejectedValue(new Error("down"));
  setup({ settings: null });
  expect(screen.getByPlaceholderText("<second brain>/daily")).toBeTruthy();
  expect(headings().map((input) => input.value)).toEqual(["Focus", "Meetings", "Sessions"]);
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  await vi.waitFor(() => expect(api.getTasksBoard).toHaveBeenCalled());
  expect(screen.getByTestId("project-order").firstElementChild?.textContent).toBe("");
});

test("editing and saving sends the daily block with trimmed values and the chosen runner", async () => {
  const { onSaveSettings } = setup();
  change(screen.getByPlaceholderText("D:/vault/daily"), " diary ");
  change(screen.getByPlaceholderText("_templates/daily.md"), " _t/d.md ");
  change(document.querySelector("textarea") as HTMLTextAreaElement, "Write {{date}}");
  await userEvent.selectOptions(screen.getByRole("combobox"), "codex");
  const [focus, meetings, sessions] = headings();
  change(focus as HTMLInputElement, " Foco ");
  change(meetings as HTMLInputElement, "Reunioes");
  change(sessions as HTMLInputElement, "Sessoes");
  change(document.querySelector("input.in:not([placeholder]):not(.frow--fields input)") as HTMLInputElement, " done ");
  await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.click(await screen.findByRole("button", { name: "reorder" }));
  expect(save().disabled).toBe(false);
  await userEvent.click(save());
  expect(onSaveSettings).toHaveBeenCalledWith({
    daily: {
      dir: "diary",
      template: "_t/d.md",
      prompt: "Write {{date}}",
      runner: "codex",
      headings: { focus: "Foco", meetings: "Reunioes", sessions: "Sessoes" },
      closedKey: "done",
      wikilinks: false,
      projectOrder: ["b", "a"],
    },
  });
});

test("empty fields save as null and empty headings and key fall back to their defaults", async () => {
  const { onSaveSettings } = setup();
  change(screen.getByPlaceholderText("D:/vault/daily"), "");
  const [focus, meetings, sessions] = headings();
  change(focus as HTMLInputElement, " ");
  change(meetings as HTMLInputElement, "");
  change(sessions as HTMLInputElement, "");
  change(document.querySelector("input.in:not([placeholder]):not(.frow--fields input)") as HTMLInputElement, "");
  await userEvent.click(save());
  expect(onSaveSettings).toHaveBeenCalledWith({
    daily: { dir: null, template: null, prompt: null, runner: "claude", headings: { focus: "Focus", meetings: "Meetings", sessions: "Sessions" }, closedKey: "closed", wikilinks: true, projectOrder: [] },
  });
});

test("every field marks the form dirty and reverting it marks it clean", async () => {
  setup();
  const dir = screen.getByPlaceholderText("D:/vault/daily");
  const template = screen.getByPlaceholderText("_templates/daily.md");
  const prompt = document.querySelector("textarea") as HTMLTextAreaElement;
  const [focus, meetings, sessions] = headings();
  const key = document.querySelector("input.in:not([placeholder]):not(.frow--fields input)") as HTMLInputElement;
  const checks: [HTMLElement, string, string][] = [
    [dir, "x", "daily"],
    [template, "x", ""],
    [prompt, "x", ""],
    [focus as HTMLElement, "x", "Focus"],
    [meetings as HTMLElement, "x", "Meetings"],
    [sessions as HTMLElement, "x", "Sessions"],
    [key, "x", "closed"],
  ];
  for (const [element, value, original] of checks) {
    change(element, value);
    expect(save().disabled).toBe(false);
    change(element, original);
    expect(save().disabled).toBe(true);
  }
  await userEvent.click(screen.getByRole("checkbox"));
  expect(save().disabled).toBe(false);
  await userEvent.click(screen.getByRole("checkbox"));
  expect(save().disabled).toBe(true);
  await userEvent.selectOptions(screen.getByRole("combobox"), "codex");
  expect(save().disabled).toBe(false);
});

test("Reset to default clears the prompt and saves null for it only", async () => {
  const { onSaveSettings } = setup({ settings: fullSettings({ daily: { ...fullSettings().daily, prompt: "custom" } }) });
  const area = document.querySelector("textarea") as HTMLTextAreaElement;
  expect(area.value).toBe("custom");
  await userEvent.click(screen.getByRole("button", { name: "Reset to default" }));
  expect(onSaveSettings).toHaveBeenCalledWith({ daily: { prompt: null } });
  expect(area.value).toBe("");
});

test("controls are locked while saving and while the hub surface is off", async () => {
  let finish: () => void = () => undefined;
  const onSaveSettings = vi.fn(() => new Promise<void>((done) => (finish = done)));
  const first = setup({ onSaveSettings });
  change(screen.getByPlaceholderText("D:/vault/daily"), "x");
  await userEvent.click(save());
  expect(save().disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Reset to default" }) as HTMLButtonElement).disabled).toBe(true);
  finish();
  await vi.waitFor(() => expect((screen.getByRole("button", { name: "Reset to default" }) as HTMLButtonElement).disabled).toBe(false));
  first.unmount();
  setup({ enabled: false });
  expect((screen.getByPlaceholderText("D:/vault/daily") as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByTestId("project-order").getAttribute("data-disabled")).toBe("true");
});

test("the form follows a settings update from the hub", () => {
  const { rerender, onSaveSettings } = setup();
  rerender(<TodayTab enabled settings={fullSettings({ daily: { ...fullSettings().daily, dir: "other", projectOrder: ["z"] } })} onSaveSettings={onSaveSettings} />);
  expect((screen.getByPlaceholderText("D:/vault/daily") as HTMLInputElement).value).toBe("other");
  expect(screen.getByTestId("order").textContent).toBe("z");
});

test("a board answer that arrives after unmount is ignored", async () => {
  let finish: (value: unknown) => void = () => undefined;
  api.getTasksBoard.mockReturnValueOnce(new Promise((done) => (finish = done)));
  const { unmount } = setup();
  unmount();
  finish({ projects: [{ id: "a" }] });
  await Promise.resolve();
  expect(document.body.textContent).toBe("");
});

test("a board failure that arrives after unmount is ignored", async () => {
  let fail: (reason: Error) => void = () => undefined;
  api.getTasksBoard.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
  const { unmount } = setup();
  unmount();
  fail(new Error("late"));
  await Promise.resolve();
  expect(document.body.textContent).toBe("");
});
