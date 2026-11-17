import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { BackupsUnavailableError, type BackupsOverview } from "../../delegation";
import { BackupsPanel, formatBackupSize } from "./BackupsPanel";

const api = vi.hoisted(() => ({ getBackups: vi.fn<() => Promise<unknown>>(), createBackup: vi.fn<() => Promise<unknown>>() }));

vi.mock("../../delegation", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../delegation")>()), getBackups: api.getBackups, createBackup: api.createBackup }));

const overview = (patch: Partial<BackupsOverview> = {}): BackupsOverview => ({
  backups: [
    { file: "a.db", reason: "upgrade", createdAt: Date.UTC(2026, 10, 1, 12), size: 2_500_000 },
    { file: "b.db", reason: "daily", createdAt: Date.UTC(2026, 10, 2, 12), size: 800 },
    { file: "c.db", reason: "manual", createdAt: Date.UTC(2026, 10, 3, 12), size: 40 * 1024 },
    { file: "d.db", reason: "pre-restore", createdAt: Date.UTC(2026, 10, 4, 12), size: 3 * 1024 ** 3 },
  ],
  lastError: null,
  backupsDir: "C:/hub/backups",
  snapshotsDir: "C:/hub/snapshots",
  snapshotDays: 7,
  ...patch,
});

beforeEach(() => {
  api.getBackups.mockReset();
  api.createBackup.mockReset();
});

test("formatBackupSize picks the unit and the precision", () => {
  expect(formatBackupSize(512)).toBe("512 B");
  expect(formatBackupSize(1536)).toBe("1.5 KB");
  expect(formatBackupSize(40 * 1024)).toBe("40 KB");
  expect(formatBackupSize(2.5 * 1024 * 1024)).toBe("2.5 MB");
  expect(formatBackupSize(3 * 1024 ** 3)).toBe("3.0 GB");
  expect(formatBackupSize(5000 * 1024 ** 3)).toBe("5000 GB");
});

test("shows a loading hint first, then the backups with their reason labels, sizes and folders", async () => {
  api.getBackups.mockResolvedValue(overview());
  render(<BackupsPanel />);
  expect(screen.getByText("Loading backups…")).toBeTruthy();
  expect(await screen.findByText("Upgrade")).toBeTruthy();
  for (const label of ["Daily", "Manual", "Before restore"]) expect(screen.getByText(label)).toBeTruthy();
  expect(screen.getByText("2.4 MB")).toBeTruthy();
  expect(screen.getByText("C:/hub/backups")).toBeTruthy();
  expect(screen.getByText("C:/hub/snapshots")).toBeTruthy();
  expect(screen.getByText("7 days of vault snapshots")).toBeTruthy();
});

test("uses the singular for one day of snapshots and says so when there are no backups", async () => {
  api.getBackups.mockResolvedValue(overview({ backups: [], snapshotDays: 1 }));
  render(<BackupsPanel />);
  expect(await screen.findByText("No backups yet.")).toBeTruthy();
  expect(screen.getByText("1 day of vault snapshots")).toBeTruthy();
});

test("explains a hub that has no backups endpoint", async () => {
  api.getBackups.mockRejectedValue(new BackupsUnavailableError("missing"));
  render(<BackupsPanel />);
  expect(await screen.findByText("Backups are not available on this hub version.")).toBeTruthy();
});

test("shows a load failure with its message or a default", async () => {
  api.getBackups.mockRejectedValueOnce(new Error("disk full"));
  const first = render(<BackupsPanel />);
  expect(await screen.findByText("disk full")).toBeTruthy();
  first.unmount();
  api.getBackups.mockRejectedValueOnce("odd");
  render(<BackupsPanel />);
  expect(await screen.findByText("request failed")).toBeTruthy();
});

test("shows the last backup failure", async () => {
  api.getBackups.mockResolvedValue(overview({ lastError: { at: Date.UTC(2026, 10, 5, 12), message: "no space left" } }));
  render(<BackupsPanel />);
  expect(await screen.findByText(/Last backup failed on .*: no space left/)).toBeTruthy();
});

test("Back up now creates a backup, then reloads the list", async () => {
  api.getBackups.mockResolvedValueOnce(overview({ backups: [] })).mockResolvedValueOnce(overview());
  let finish: (value: unknown) => void = () => undefined;
  api.createBackup.mockReturnValueOnce(new Promise((done) => (finish = done)));
  render(<BackupsPanel />);
  const button = await screen.findByRole("button", { name: "Back up now" });
  await userEvent.click(button);
  expect(screen.getByRole("button", { name: "Backing up…" }).hasAttribute("disabled")).toBe(true);
  finish({ backup: {} });
  expect(await screen.findByText("Upgrade")).toBeTruthy();
  expect(api.createBackup).toHaveBeenCalledTimes(1);
  expect(api.getBackups).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("button", { name: "Back up now" }).hasAttribute("disabled")).toBe(false);
});

test("a failed backup shows its error next to the button and can be retried", async () => {
  api.getBackups.mockResolvedValue(overview({ backups: [] }));
  api.createBackup.mockRejectedValueOnce(new Error("vault locked")).mockRejectedValueOnce("odd");
  render(<BackupsPanel />);
  await userEvent.click(await screen.findByRole("button", { name: "Back up now" }));
  expect(await screen.findByText("vault locked")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Back up now" }));
  expect(await screen.findByText("request failed")).toBeTruthy();
});

test("an answer that arrives after unmount is dropped", async () => {
  let finish: (value: unknown) => void = () => undefined;
  api.getBackups.mockReturnValueOnce(new Promise((done) => (finish = done)));
  const { unmount } = render(<BackupsPanel />);
  unmount();
  finish(overview());
  await Promise.resolve();
  expect(document.body.textContent).toBe("");
});
