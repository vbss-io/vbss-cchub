import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { permission } from "../test-support/u3-fixtures";
import type { ApprovalItem } from "../approvals-model";

const ctx = vi.hoisted(() => ({
  now: 0,
  decide: vi.fn<(id: string, behavior: "allow" | "deny", reason: string) => Promise<void>>(),
  answer: vi.fn<(id: string, answers: Record<string, string>) => Promise<void>>(),
  release: vi.fn<(id: string) => Promise<void>>(),
}));
const api = vi.hoisted(() => ({ openSession: vi.fn(async () => ({ ok: true })) }));

vi.mock("../approvals-context", () => ({ useApprovals: () => ctx }));
vi.mock("../api", () => api);

import { ApprovalList, ApprovalRequest } from "./ApprovalRequest";

const questionInput = {
  questions: [
    { question: "Which db?", header: "DB", multiSelect: false, options: [{ label: "pg", description: "Postgres" }, { label: "my", description: "" }] },
    { question: "Which flags?", header: "", multiSelect: true, options: [{ label: "a", description: "" }, { label: "b", description: "" }] },
  ],
};

const ask = (overrides: Partial<ApprovalItem> = {}): ApprovalItem => permission({ id: "ask-1", toolName: "AskUserQuestion", toolInput: questionInput, ...overrides });

beforeEach(() => {
  ctx.now = Date.now();
  ctx.decide.mockReset().mockResolvedValue(undefined);
  ctx.answer.mockReset().mockResolvedValue(undefined);
  ctx.release.mockReset().mockResolvedValue(undefined);
  api.openSession.mockClear();
});

test("shows the tool, its input, the folder and the countdown for a tool request", () => {
  const request = permission({ expiresAt: ctx.now + 30_000, createdAt: ctx.now });
  render(<ApprovalRequest request={request} showTitle />);
  const group = screen.getByRole("group", { name: "Permission request for Bash" });
  expect(within(group).getByText("Bash")).toBeTruthy();
  expect(within(group).getByText("npm test")).toBeTruthy();
  expect(within(group).getByText("Refactor auth")).toBeTruthy();
  expect(within(group).getByText("30s left")).toBeTruthy();
  expect(within(group).getByText("work/api")).toBeTruthy();
});

test("marks a subagent request and an urgent countdown", () => {
  const request = permission({ agentId: "sub-1", expiresAt: ctx.now + 5_000, createdAt: ctx.now - 55_000 });
  render(<ApprovalRequest request={request} />);
  expect(screen.getByText("Bash · subagent")).toBeTruthy();
  expect(screen.getByText("5s left").className).toContain("approval__left--urgent");
});

test("allow sends the decision and shows the sending label while busy", async () => {
  let finish: () => void = () => undefined;
  ctx.decide.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
  render(<ApprovalRequest request={permission()} />);
  await userEvent.click(screen.getByRole("button", { name: "Allow" }));
  expect(ctx.decide).toHaveBeenCalledWith("perm-1", "allow", "");
  expect((screen.getByRole("button", { name: "Sending..." }) as HTMLButtonElement).disabled).toBe(true);
  finish();
});

test("deny opens the reason field, sends it on Enter and cancels with Escape", async () => {
  const user = userEvent.setup();
  render(<ApprovalRequest request={permission()} />);
  await user.click(screen.getByRole("button", { name: "Deny" }));
  const reason = screen.getByLabelText("Reason for the agent (optional)");
  await user.type(reason, "too risky");
  await user.keyboard("{Enter}");
  expect(ctx.decide).toHaveBeenCalledWith("perm-1", "deny", "too risky");
});

test("escape inside the reason field returns to the first actions and clears the text", async () => {
  const user = userEvent.setup();
  render(<ApprovalRequest request={permission()} />);
  await user.click(screen.getByRole("button", { name: "Deny" }));
  await user.type(screen.getByLabelText("Reason for the agent (optional)"), "abc");
  await user.keyboard("{Escape}");
  expect(screen.queryByLabelText("Reason for the agent (optional)")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Deny" }));
  expect((screen.getByLabelText("Reason for the agent (optional)") as HTMLInputElement).value).toBe("");
});

test("the send deny and cancel buttons work from the reason state", async () => {
  const user = userEvent.setup();
  render(<ApprovalRequest request={permission()} />);
  await user.click(screen.getByRole("button", { name: "Deny" }));
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Deny" }));
  await user.type(screen.getByLabelText("Reason for the agent (optional)"), "no");
  await user.click(screen.getByRole("button", { name: "Send deny" }));
  expect(ctx.decide).toHaveBeenCalledWith("perm-1", "deny", "no");
});

test("without a reason field deny is sent straight away", async () => {
  render(<ApprovalRequest request={permission()} reasonField={false} />);
  await userEvent.click(screen.getByRole("button", { name: "Deny" }));
  expect(ctx.decide).toHaveBeenCalledWith("perm-1", "deny", "");
});

test("a failing decision shows the error and re-enables the buttons", async () => {
  ctx.decide.mockRejectedValueOnce(new Error("hub said no"));
  render(<ApprovalRequest request={permission()} />);
  await userEvent.click(screen.getByRole("button", { name: "Allow" }));
  expect(await screen.findByText("hub said no")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement).disabled).toBe(false);
  ctx.decide.mockRejectedValueOnce("weird");
  await userEvent.click(screen.getByRole("button", { name: "Allow" }));
  expect(await screen.findByText("The decision was not sent.")).toBeTruthy();
});

test("a request still loading details cannot be allowed", () => {
  const request: ApprovalItem = { ...permission(), pendingDetails: true };
  render(<ApprovalRequest request={request} />);
  expect(screen.getByText("Loading the request...")).toBeTruthy();
  const allow = screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement;
  expect(allow.disabled).toBe(true);
  expect(allow.title).toBe("Wait until the request is shown");
});

test("a question needs every answer before it can be sent, then posts the answers", async () => {
  const user = userEvent.setup();
  render(<ApprovalRequest request={ask()} />);
  const send = screen.getByRole("button", { name: "Answer" }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  expect(send.title).toBe("Answer every question first");
  await user.click(screen.getByLabelText(/^pg/));
  await user.click(screen.getByLabelText("a"));
  await user.click(screen.getByLabelText("b"));
  expect(send.disabled).toBe(false);
  await user.click(send);
  expect(ctx.answer).toHaveBeenCalledWith("ask-1", { "Which db?": "pg", "Which flags?": "a, b" });
});

test("answering in the session releases the request and opens the session", async () => {
  const onOpenSession = vi.fn();
  render(<ApprovalRequest request={ask()} onOpenSession={onOpenSession} />);
  await userEvent.click(screen.getByRole("button", { name: "Answer in session" }));
  expect(ctx.release).toHaveBeenCalledWith("ask-1");
  await vi.waitFor(() => expect(onOpenSession).toHaveBeenCalledTimes(1));
  expect(onOpenSession.mock.calls[0]?.[0]).toMatchObject({ id: "ask-1", sessionId: "sess-0001-aaaa" });
});

test("the default open handler opens the session through the hub and swallows errors", async () => {
  render(<ApprovalRequest request={ask()} />);
  await userEvent.click(screen.getByRole("button", { name: "Answer in session" }));
  await vi.waitFor(() => expect(api.openSession).toHaveBeenCalledWith("sess-0001-aaaa"));
  api.openSession.mockRejectedValueOnce(new Error("no app"));
  render(<ApprovalRequest request={ask({ id: "ask-2" })} />);
  await userEvent.click(screen.getAllByRole("button", { name: "Answer in session" })[1] as HTMLElement);
  await vi.waitFor(() => expect(api.openSession).toHaveBeenCalledTimes(2));
});

test("a question that arrives without its questions can only be answered in the session", () => {
  render(<ApprovalRequest request={ask({ toolInput: {} })} />);
  expect(screen.getByText("The questions did not come with the request. Answer them in the session.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
  expect(screen.getByRole("button", { name: "Answer in session" })).toBeTruthy();
});

test("a plan request shows the plan and uses the plan wording", async () => {
  const request = permission({ id: "plan-1", toolName: "ExitPlanMode", toolInput: { plan: "Step one\n\nStep two", planFilePath: "C:/plans/p.md" } });
  render(<ApprovalRequest request={request} />);
  expect(screen.getByText("Plan", { selector: ".approval__tool" })).toBeTruthy();
  expect(screen.getByText("Step one")).toBeTruthy();
  expect(screen.getByText("p.md")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Approve plan" }));
  expect(ctx.decide).toHaveBeenCalledWith("plan-1", "allow", "");
});

test("keep planning asks what to change in the plan", async () => {
  const request = permission({ id: "plan-2", toolName: "ExitPlanMode", toolInput: { plan: "Only step" } });
  render(<ApprovalRequest request={request} />);
  await userEvent.click(screen.getByRole("button", { name: "Keep planning" }));
  expect(screen.getByLabelText("What to change in the plan (optional)")).toBeTruthy();
});

test("the compact variant carries its class and stops click propagation", async () => {
  const outer = vi.fn();
  render(
    <div onClick={outer}>
      <ApprovalRequest request={permission()} compact />
    </div>,
  );
  const group = screen.getByRole("group");
  expect(group.className).toContain("approval--compact");
  await userEvent.click(group);
  expect(outer).not.toHaveBeenCalled();
});

test("text focus in the reason field is reported to the host", async () => {
  const onTextFocus = vi.fn();
  render(<ApprovalRequest request={permission()} onTextFocus={onTextFocus} />);
  await userEvent.click(screen.getByRole("button", { name: "Deny" }));
  expect(onTextFocus).toHaveBeenCalledWith(screen.getByLabelText("Reason for the agent (optional)"));
});

test("ApprovalList renders nothing for an empty list and one card per request otherwise", () => {
  const empty = render(<ApprovalList requests={[]} />);
  expect(empty.container.firstChild).toBeNull();
  empty.unmount();
  render(<ApprovalList requests={[permission({ id: "a" }), permission({ id: "b", toolName: "Edit" })]} compact showTitle reasonField={false} />);
  expect(screen.getAllByRole("group")).toHaveLength(2);
  expect(screen.getByRole("group", { name: "Permission request for Edit" })).toBeTruthy();
});
