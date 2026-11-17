import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, test, vi } from "vitest";
import { EMPTY_DRAFT, type AskQuestion, type QuestionDraft } from "../approvals-model";
import { ApprovalQuestions } from "./ApprovalQuestions";

const single: AskQuestion = { question: "Which db?", header: "DB", multiSelect: false, options: [{ label: "pg", description: "Postgres" }, { label: "my", description: "" }] };
const multi: AskQuestion = { question: "Which flags?", header: "", multiSelect: true, options: [{ label: "a", description: "" }, { label: "b", description: "" }] };

function Stateful({ questions, onTextFocus, disabled = false }: { questions: AskQuestion[]; onTextFocus?: (element: HTMLElement) => void; disabled?: boolean }) {
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({});
  return <ApprovalQuestions questions={questions} drafts={drafts} disabled={disabled} onChange={(question, draft) => setDrafts((prev) => ({ ...prev, [question]: draft }))} onTextFocus={onTextFocus} />;
}

test("renders a radio group with header, description and an other field for a single choice", () => {
  render(<Stateful questions={[single]} />);
  expect(screen.getByText("DB")).toBeTruthy();
  expect(screen.getByText("Which db?")).toBeTruthy();
  expect(screen.getByText("Postgres")).toBeTruthy();
  expect(screen.getAllByRole("radio")).toHaveLength(3);
  expect(screen.queryByText("Pick any")).toBeNull();
  expect(screen.getByLabelText(/^pg/).closest("label")?.getAttribute("title")).toBe("Postgres");
  expect(screen.getByLabelText("my").closest("label")?.getAttribute("title")).toBeNull();
});

test("a multi choice renders checkboxes with the pick any hint", () => {
  render(<Stateful questions={[multi]} />);
  expect(screen.getAllByRole("checkbox")).toHaveLength(3);
  expect(screen.getByText("Pick any")).toBeTruthy();
});

test("picking an option selects only that radio", async () => {
  const user = userEvent.setup();
  render(<Stateful questions={[single]} />);
  await user.click(screen.getByLabelText(/^pg/));
  expect((screen.getByLabelText(/^pg/) as HTMLInputElement).checked).toBe(true);
  await user.click(screen.getByLabelText("my"));
  expect((screen.getByLabelText(/^pg/) as HTMLInputElement).checked).toBe(false);
  expect((screen.getByLabelText("my") as HTMLInputElement).checked).toBe(true);
});

test("typing in the other field turns it on and clears the radio choice", async () => {
  const user = userEvent.setup();
  const onTextFocus = vi.fn();
  render(<Stateful questions={[single]} onTextFocus={onTextFocus} />);
  await user.click(screen.getByLabelText(/^pg/));
  await user.type(screen.getByLabelText("Other answer for: Which db?"), "sqlite");
  expect((screen.getByLabelText("Other") as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText(/^pg/) as HTMLInputElement).checked).toBe(false);
  expect((screen.getByLabelText("Other answer for: Which db?") as HTMLInputElement).value).toBe("sqlite");
  expect(onTextFocus).toHaveBeenCalledWith(screen.getByLabelText("Other answer for: Which db?"));
});

test("the other toggle works for single and multi questions", async () => {
  const user = userEvent.setup();
  render(<Stateful questions={[single, multi]} />);
  const others = screen.getAllByLabelText("Other");
  await user.click(others[0] as HTMLElement);
  expect((others[0] as HTMLInputElement).checked).toBe(true);
  await user.click(others[1] as HTMLElement);
  expect((others[1] as HTMLInputElement).checked).toBe(true);
  await user.click(others[1] as HTMLElement);
  expect((others[1] as HTMLInputElement).checked).toBe(false);
});

test("multi options toggle independently and the other text keeps the options", async () => {
  const user = userEvent.setup();
  render(<Stateful questions={[multi]} />);
  await user.click(screen.getByLabelText("a"));
  await user.click(screen.getByLabelText("b"));
  expect((screen.getByLabelText("a") as HTMLInputElement).checked).toBe(true);
  await user.type(screen.getByLabelText("Other answer for: Which flags?"), "z");
  expect((screen.getByLabelText("a") as HTMLInputElement).checked).toBe(true);
  await user.click(screen.getByLabelText("a"));
  expect((screen.getByLabelText("a") as HTMLInputElement).checked).toBe(false);
});

test("renders existing drafts and disables the fieldsets while busy", () => {
  const drafts = { [single.question]: { ...EMPTY_DRAFT, selected: ["my"] } };
  render(<ApprovalQuestions questions={[single]} drafts={drafts} disabled onChange={() => undefined} />);
  expect((screen.getByLabelText("my") as HTMLInputElement).checked).toBe(true);
  expect(screen.getByRole("group", { name: /Which db\?/ }).hasAttribute("disabled")).toBe(true);
});
