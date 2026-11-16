import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const mode = process.env.FAKE_GH_MODE ?? "";
const capture = process.env.FAKE_GH_CAPTURE;
if (capture) appendFileSync(capture, `${JSON.stringify({ argv, cwd: process.cwd() })}\n`);

const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const fail = (message, code = 1) => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};

const [command, sub] = argv;
if (command === "--version") {
  process.stdout.write("gh version 2.99.0 (fake)\n");
} else if (command === "auth" && sub === "status") {
  if (mode === "unauth") fail("You are not logged into any GitHub hosts. To log in, run: gh auth login");
  process.stdout.write("github.com\n  Logged in to github.com account fake\n");
} else if (command === "pr" && sub === "view") {
  if (mode === "nopr") fail(`no pull requests found for branch "${argv[2]}"`);
  out({
    number: 42,
    title: "feat: fake change",
    state: "OPEN",
    url: "https://github.example/fake/pull/42",
    headRefName: argv[2],
    isDraft: false,
    statusCheckRollup: [
      { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE" },
      { __typename: "CheckRun", name: "lint", status: "IN_PROGRESS", conclusion: "" },
      { __typename: "StatusContext", context: "deploy", state: "PENDING" },
    ],
  });
} else if (command === "run" && sub === "list") {
  const branch = argv[argv.indexOf("--branch") + 1];
  out([
    { databaseId: 7, displayTitle: "CI", status: "completed", conclusion: "failure", workflowName: "ci", url: "https://github.example/fake/actions/runs/7", createdAt: "2026-11-15T10:00:00Z", headBranch: branch, event: "push" },
    { databaseId: 6, displayTitle: "CI", status: "completed", conclusion: "success", workflowName: "ci", url: "https://github.example/fake/actions/runs/6", createdAt: "2026-11-14T10:00:00Z", headBranch: branch, event: "push" },
  ]);
} else {
  fail(`fake gh: unsupported command ${argv.join(" ")}`, 2);
}
