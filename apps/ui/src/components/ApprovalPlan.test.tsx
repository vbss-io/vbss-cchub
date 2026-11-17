import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { ApprovalPlan } from "./ApprovalPlan";

test("renders the plan markdown and the plan file name", () => {
  render(<ApprovalPlan plan={{ plan: "## Steps\n\n- first\n- second", path: "C:\\plans\\release.md" }} lines={6} />);
  expect(screen.getByRole("heading", { name: "Steps" })).toBeTruthy();
  expect(screen.getByText("first")).toBeTruthy();
  const file = screen.getByText("release.md");
  expect(file.getAttribute("title")).toBe("C:\\plans\\release.md");
});

test("says so when the plan text is missing and omits the file when there is no path", () => {
  render(<ApprovalPlan plan={{ plan: "   ", path: null }} lines={3} />);
  expect(screen.getByText("The plan text did not come with the request.")).toBeTruthy();
  expect(document.querySelectorAll(".approval__cwd")).toHaveLength(1);
});
