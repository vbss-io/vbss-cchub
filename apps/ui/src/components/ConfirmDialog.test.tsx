import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

const setup = (props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) => {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  const view = render(<ConfirmDialog title="Delete it?" body="This cannot be undone." confirmLabel="Delete" onCancel={onCancel} onConfirm={onConfirm} {...props} />);
  return { onCancel, onConfirm, ...view };
};

test("shows the title, the body and the confirm label in an accessible dialog", () => {
  setup();
  const dialog = screen.getByRole("dialog", { name: "Delete it?" });
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(screen.getByText("This cannot be undone.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Delete" }).className).toContain("act--focus");
});

test("the danger style marks the confirm button", () => {
  setup({ danger: true });
  expect(screen.getByRole("button", { name: "Delete" }).className).toContain("act--danger");
});

test("Confirm reports unchecked when there is no checkbox", async () => {
  const { onConfirm, onCancel } = setup();
  await userEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(onConfirm).toHaveBeenCalledWith(false);
  expect(onCancel).not.toHaveBeenCalled();
});

test("Cancel, the overlay and Escape all cancel, while a click inside the dialog does not", async () => {
  const { onCancel, container } = setup();
  await userEvent.click(screen.getByRole("dialog"));
  expect(onCancel).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCancel).toHaveBeenCalledTimes(1);
  await userEvent.click(container.querySelector(".modal__overlay") as Element);
  expect(onCancel).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(onCancel).toHaveBeenCalledTimes(3);
  fireEvent.keyDown(window, { key: "Enter" });
  expect(onCancel).toHaveBeenCalledTimes(3);
});

test("the optional checkbox starts from its initial value and its state is reported on confirm", async () => {
  const { onConfirm } = setup({ checkbox: { label: "Also delete the files", initial: true } });
  const box = screen.getByRole("checkbox", { name: "Also delete the files" }) as HTMLInputElement;
  expect(box.checked).toBe(true);
  await userEvent.click(box);
  expect(box.checked).toBe(false);
  await userEvent.click(box);
  await userEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(onConfirm).toHaveBeenCalledWith(true);
});

test("the checkbox defaults to unchecked", async () => {
  const { onConfirm } = setup({ checkbox: { label: "Remember" } });
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(onConfirm).toHaveBeenCalledWith(false);
});

test("the Escape listener is removed when the dialog unmounts", () => {
  const { onCancel, unmount } = setup();
  unmount();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(onCancel).not.toHaveBeenCalled();
});
