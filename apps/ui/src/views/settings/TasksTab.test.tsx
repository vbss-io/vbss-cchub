import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { DelegationSettings } from "../../delegation";
import { fullSettings } from "../../test-support/u5-fixtures";
import { TasksTab } from "./TasksTab";

const setup = (props: Partial<Parameters<typeof TasksTab>[0]> = {}) => {
  const onSaveSettings = vi.fn(async () => undefined);
  const view = render(<TasksTab enabled settings={fullSettings()} onSaveSettings={onSaveSettings} {...props} />);
  return { onSaveSettings, ...view };
};

const field = (placeholder: string): HTMLInputElement => screen.getAllByPlaceholderText(placeholder)[0] as HTMLInputElement;
const save = (): HTMLButtonElement => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
const change = (element: HTMLElement, value: string): void => void fireEvent.change(element, { target: { value } });

const savedTasks = (): DelegationSettings["tasks"] => fullSettings().tasks;

test("shows the saved values and Save starts disabled", () => {
  setup();
  expect(field("Open loops").value).toBe("Open loops");
  expect(field("BLOCK, BLOCKED").value).toBe("BLOCK");
  expect(field("HOLD").value).toBe("HOLD");
  expect(field("ARCHIVED").value).toBe("ARCHIVED");
  expect(field("Done loops").value).toBe("Done loops");
  expect(field("_*").value).toBe("arquivo");
  expect(screen.getByPlaceholderText("4")).toHaveProperty("value", "4");
  expect(save().disabled).toBe(true);
});

test("without settings the form uses the built-in defaults and a generic folder hint", () => {
  setup({ settings: null });
  expect(field("Open loops").value).toBe("Open loops");
  expect(field("BLOCK, BLOCKED").value).toBe("BLOCK, BLOCKED");
  expect(field("_*").value).toBe("_*");
  expect(field("p").value).toBe("p");
  expect(screen.getByPlaceholderText("<second brain>/projects")).toBeTruthy();
  expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
});

test("the folder placeholder points inside the second brain when one is set", () => {
  setup();
  expect(screen.getByPlaceholderText("D:/vault/projects")).toBeTruthy();
});

test("editing any field and saving sends the whole tasks block, trimmed and parsed", async () => {
  const { onSaveSettings } = setup();
  change(screen.getByPlaceholderText("D:/vault/projects"), "  projetos/vbss ");
  change(field("Open loops"), " Loops ");
  change(field("BLOCK, BLOCKED"), "BLOCK, STUCK");
  change(field("HOLD"), "HOLD,  WAIT ,");
  change(field("ARCHIVED"), "ARCHIVED");
  change(document.querySelectorAll<HTMLInputElement>('input[placeholder=" - "]')[0] as HTMLInputElement, ": ");
  change(document.querySelectorAll<HTMLInputElement>('input[placeholder=" - "]')[1] as HTMLInputElement, " | ");
  change(field("Done loops"), " Finished ");
  change(field("✅ {{date}}"), " ✓ {{date}}");
  change(field("p"), " q ");
  change(field("4"), " 5 ");
  change(field("_*"), "arquivo, _*");
  const keys = document.querySelectorAll<HTMLInputElement>("input.in:not([placeholder])");
  change(keys[0] as HTMLInputElement, " ws ");
  change(keys[1] as HTMLInputElement, " up ");
  change(document.querySelector("textarea") as HTMLTextAreaElement, "Do {{task}}");
  await userEvent.click(screen.getByRole("checkbox", { name: /Mark a To-Do task as Doing/ }));
  expect(save().disabled).toBe(false);
  await userEvent.click(save());
  expect(onSaveSettings).toHaveBeenCalledWith({
    tasks: {
      root: "projetos/vbss",
      section: "Loops",
      prefixes: { blocked: ["BLOCK", "STUCK"], hold: ["HOLD", "WAIT"], archived: ["ARCHIVED"] },
      separator: ": ",
      reasonSeparator: " | ",
      doneSection: "Finished",
      doneStamp: " ✓ {{date}}",
      exclude: ["arquivo", "_*"],
      workspaceKey: "ws",
      parentKey: "up",
      delegatePrompt: "Do {{task}}",
      markDoingOnDelegate: false,
      priorityTag: "q",
      priorityLevels: 5,
    },
  });
});

test("an empty folder and an empty prompt are saved as null", async () => {
  const { onSaveSettings } = setup();
  change(screen.getByPlaceholderText("D:/vault/projects"), "");
  change(document.querySelector("textarea") as HTMLTextAreaElement, "   ");
  await userEvent.click(save());
  const sent = (onSaveSettings.mock.calls[0] as unknown as [{ tasks: Record<string, unknown> }])[0].tasks;
  expect(sent.root).toBeNull();
  expect(sent.delegatePrompt).toBeNull();
  expect(sent.priorityLevels).toBe(4);
});

test("every kind of change makes the form dirty, and reverting it makes it clean again", () => {
  setup();
  const checks: [HTMLElement, string, string][] = [
    [field("Open loops"), "X", "Open loops"],
    [field("BLOCK, BLOCKED"), "BLOCK, X", "BLOCK"],
    [field("HOLD"), "HOLD, X", "HOLD"],
    [field("ARCHIVED"), "ARCHIVED, X", "ARCHIVED"],
    [field("Done loops"), "X", "Done loops"],
    [field("p"), "x", "p"],
    [field("_*"), "x", "arquivo"],
  ];
  for (const [element, value, original] of checks) {
    change(element, value);
    expect(save().disabled).toBe(false);
    change(element, original);
    expect(save().disabled).toBe(true);
  }
});

test("invalid values show their message and block Save", () => {
  setup();
  change(field("4"), "0");
  expect(screen.getByText("Use a whole number from 1 to 10")).toBeTruthy();
  expect(save().disabled).toBe(true);
  change(field("4"), "4");
  change(field("p"), "bad tag");
  expect(screen.getByText("Use letters, digits, - or _ only")).toBeTruthy();
  change(field("p"), "p");
  change(document.querySelectorAll<HTMLInputElement>('input[placeholder=" - "]')[1] as HTMLInputElement, "  ");
  expect(screen.getByText(/Use a separator with some text in it/)).toBeTruthy();
  change(document.querySelectorAll<HTMLInputElement>('input[placeholder=" - "]')[1] as HTMLInputElement, " - ");
  change(field("✅ {{date}}"), "no date");
  expect(screen.getByText("The stamp must contain {{date}}")).toBeTruthy();
  change(field("✅ {{date}}"), " ✅ {{date}}");
  expect(save().disabled).toBe(true);
  change(field("Open loops"), "Loops");
  expect(save().disabled).toBe(false);
});

test("a status without any prefix word blocks Save with an explanation", () => {
  setup();
  change(field("HOLD"), " , ");
  expect(screen.getByText("Each status needs at least one prefix word.")).toBeTruthy();
  expect(save().disabled).toBe(true);
});

test("Reset to default clears the prompt and saves null for it only", async () => {
  const { onSaveSettings } = setup({ settings: fullSettings({ tasks: { ...savedTasks(), delegatePrompt: "custom" } }) });
  const area = document.querySelector("textarea") as HTMLTextAreaElement;
  expect(area.value).toBe("custom");
  await userEvent.click(screen.getByRole("button", { name: "Reset to default" }));
  expect(onSaveSettings).toHaveBeenCalledWith({ tasks: { delegatePrompt: null } });
  expect(area.value).toBe("");
});

test("Save is disabled and the controls are locked while saving or when the hub surface is off", async () => {
  let finish: () => void = () => undefined;
  const onSaveSettings = vi.fn(() => new Promise<void>((done) => (finish = done)));
  const first = setup({ onSaveSettings });
  change(field("Open loops"), "Changed");
  await userEvent.click(save());
  expect(save().disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Reset to default" }) as HTMLButtonElement).disabled).toBe(true);
  finish();
  await vi.waitFor(() => expect((screen.getByRole("button", { name: "Reset to default" }) as HTMLButtonElement).disabled).toBe(false));
  first.unmount();
  setup({ enabled: false });
  expect(field("Open loops").disabled).toBe(true);
  expect(save().disabled).toBe(true);
});

test("the form follows a settings update from the hub", () => {
  const { rerender, onSaveSettings } = setup();
  rerender(<TasksTab enabled settings={fullSettings({ tasks: { ...savedTasks(), section: "Backlog", priorityLevels: 6 } })} onSaveSettings={onSaveSettings} />);
  expect(field("Open loops").value).toBe("Backlog");
  expect(screen.getByPlaceholderText("4")).toHaveProperty("value", "6");
});
