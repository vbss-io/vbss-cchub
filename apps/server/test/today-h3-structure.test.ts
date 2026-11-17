import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { DelegationSettings } from "../src/delegation-types.js";

const dataDir = mkdtempSync(join(tmpdir(), "cch-today-h3-data-"));
process.env.HUB_DATA_DIR = dataDir;
delete process.env.HUB_RESOURCE_DIR;
delete process.env.HUB_WORKSPACES_ROOT;
delete process.env.HUB_EDITOR;
delete process.env.HUB_SECOND_BRAIN;

type Store = typeof import("../src/delegation-store.js");
type Board = typeof import("../src/tasks-board.js");
type Daily = typeof import("../src/daily.js");
type Today = typeof import("../src/today.js");
type BoardTask = import("../src/tasks-board.js").BoardTask;
let store: Store;
let board: Board;
let daily: Daily;
let today: Today;

const SCHEDULED = "⏳";
const DONE = "✅";
const roots: string[] = [];

before(async () => {
  store = await import("../src/delegation-store.js");
  board = await import("../src/tasks-board.js");
  daily = await import("../src/daily.js");
  today = await import("../src/today.js");
  today.installTodayHooks();
  today.setFocusStability({ delayMs: 0, reread: null });
});

beforeEach(() => today.forgetTodayState());
afterEach(() => today.forgetTodayState());

after(async () => {
  today.removeTodayHooks();
  daily.stopDailyWatch();
  board.stopTasksBoardWatch();
  (await import("../src/db.js")).db.close();
  for (const dir of [dataDir, ...roots]) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function dayOf(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

function shift(date: string, days: number): string {
  const at = new Date(`${date}T12:00:00`);
  at.setDate(at.getDate() + days);
  return dayOf(at);
}

const TODAY = dayOf(new Date());
const YESTERDAY = shift(TODAY, -1);
const TEMPLATE = ["---", "type: daily", "---", "", "# {{date}}", "", "## Focus", "", "- [ ]", "", "## Meetings", "", "-", ""].join("\n");

function write(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

function project(title: string, open: string[], done: string[] = ["-"]): string {
  return [`# ${title}`, "", "## Open loops", "", ...open, "", "## Done loops", "", ...done, ""].join("\n");
}

function dailyOf(date: string, focus: string[]): string {
  return ["---", "type: daily", "---", "", `# ${date}`, "", "## Focus", "", ...focus, "", "## Meetings", "", "- 10:00 Standup", ""].join("\n");
}

function lab(projects: Record<string, string>, dailies: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cch-today-h3-vault-"));
  roots.push(root);
  write(root, "_templates/daily.md", TEMPLATE);
  for (const [name, content] of Object.entries(projects)) write(root, `projects/${name}.md`, content);
  for (const [date, content] of Object.entries(dailies)) write(root, `daily/${date}.md`, content);
  return root;
}

function useVault(root: string): DelegationSettings {
  store.updateSettings({
    secondBrainRoot: root,
    features: { daily: true, tasks: true, trail: false, usage: false, limits: false },
    tasks: { root: "projects", doneSection: "Done loops", priorityTag: "p" },
    daily: {
      dir: "daily",
      template: "_templates/daily.md",
      wikilinks: true,
      projectOrder: [],
      focusSource: "scheduled",
      headings: { focus: "Focus", meetings: "Meetings", sessions: "Sessions", captures: "" },
    },
  });
  store.setSetting(`today.migrated.${TODAY}`, "1");
  store.setSetting(`today.migrated.${YESTERDAY}`, "1");
  return store.getSettings();
}

function flatten(tasks: BoardTask[]): BoardTask[] {
  return tasks.flatMap((task) => [task, ...flatten(task.subtasks)]);
}

function taskIn(settings: DelegationSettings, projectId: string, title: string): BoardTask {
  const found = flatten(board.readBoard(settings).tasks).find((task) => task.projectId === projectId && task.title === title);
  assert.ok(found, `${projectId}: ${title}`);
  return found;
}

const dailyRel = (date: string): string => `daily/${date}.md`;

function editProject(root: string, name: string, change: (content: string) => string): void {
  const file = join(root, `projects/${name}.md`);
  writeFileSync(file, change(readFileSync(file, "utf8")));
}

function settle(settings: DelegationSettings, date: string = TODAY): void {
  for (let round = 0; round < 3; round += 1) {
    today.flushMirrors(settings);
    today.todayApi.regenerateFocusMirror(settings, date);
  }
}

function assertSettled(settings: DelegationSettings, root: string, date: string = TODAY): void {
  const before = read(root, dailyRel(date));
  for (let round = 0; round < 3; round += 1) assert.equal(today.todayApi.regenerateFocusMirror(settings, date).changed, false, `round ${round}`);
  assert.equal(read(root, dailyRel(date)), before);
}

function focusLines(root: string, date: string = TODAY): string[] {
  const lines = read(root, dailyRel(date)).split(/\r\n|\n/);
  const start = lines.indexOf("## Focus");
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start + 2, end - 1);
}

const focusTitles = (settings: DelegationSettings): string[] => today.readToday(settings, TODAY).focus.map((entry) => entry.task.title);

const EQ = "[[equatorial|Equatorial]]";
const WK = "[[workai|Workai]]";
const SERVERS = "Infra: Servidores de dados por projeto (um projeto pesado não derrubar os outros)";
const PHASE = "Fase 0: Limites e réplicas (rede de segurança no servidor compartilhado)";
const ZERO_A = "0a em DEV: statement_timeout 120s + CONNECTION LIMIT 60 só em banco novo";
const ZERO_B = "0b: rate limit por projeto na lib-platform, em modo medição (só loga) antes de bloquear";
const BACKFILL = "Backfill: statement_timeout nos bancos que já existem (levantar no PI/pg_stat_statements quem passa de 2 min antes)";
const PROMOTE = "Promover fase 0 + fix do dbgateway p/ QA e PRD (só depois de fechar)";
const EXTEND = "Estender pros outros recursos compartilhados que um projeto consegue saturar";
const TRAIN = "Plataforma: PoC ML - Treino";
const T3 = "T3: modelo pronto (JumpStart) avaliado e descartado - detectores de terceiros antigos que só devolvem caixas; o T2 cobre";
const DATASET = "Dataset rotulado original no lugar do semente - Aguardando retorno Lucas (demo_isoladores)";
const DATASET_NOTE = "BLOCK - Dataset rotulado original no lugar do semente - aguardando quem treinou o demo_isoladores";
const FEEGOW = "**Feegow**: levar os recursos da Medware pro Feegow";
const MAPPING = "Mapeamento do que a Medware tem e o Feegow não";
const CONSOLE = "Console: lembretes do Feegow + tela de criação que apagava config  _Falta Deploy_";
const PUBLISH = "Publicar na ordem Medware > Feegow > Console";
const CRM = "Feegow + CRM: mover o card do CRM quando o status do agendamento muda no Feegow";
const AGENDA = "Agenda do médico: PDF diário com a agenda do dia seguinte";
const MEDWARE = "**Medware**: lembrete pós-consulta (D+N) que se perdia depois da consulta _Falta Deploy_";

function equatorialWithPhase(date: string): string {
  return project("Equatorial", [
    `- [-] ${SERVERS} ${SCHEDULED} ${date}`,
    `  - [x] Proposta com 3 opções pro extra ${DONE} 2026-11-12`,
    `  - [-] ${PHASE} ${SCHEDULED} ${date}`,
    `    - [x] ${ZERO_A} ${DONE} 2026-11-16`,
    `    - [ ] ${ZERO_B} ${SCHEDULED} ${date}`,
    `    - [ ] ${BACKFILL} ${SCHEDULED} ${date}`,
    `    - [ ] ${PROMOTE} ${SCHEDULED} ${date}`,
    "  - [x] Fase 1: Cadastro de servidores e campo `server`",
    `  - [ ] ${EXTEND}`,
  ]);
}

const EQUATORIAL_AFTER = project(
  "Equatorial",
  [`- [ ] ${BACKFILL} ${SCHEDULED} ${TODAY}`, "", `- [-] ${TRAIN} ${SCHEDULED} ${TODAY}`, `  - [x] ${T3} ${DONE} ${TODAY}`, `  - [x] ${DATASET}`],
  [
    `- [x] ${SERVERS} ${SCHEDULED} ${TODAY} ${DONE} ${TODAY}`,
    `  - [x] ${PHASE} ${SCHEDULED} ${TODAY}`,
    `    - [x] ${ZERO_A} ${DONE} 2026-11-16`,
    `    - [x] ${ZERO_B} ${SCHEDULED} ${TODAY}`,
    `    - [x] ${PROMOTE} ${SCHEDULED} ${TODAY}`,
    `  - [x] ${EXTEND} ${SCHEDULED} ${TODAY}`,
  ],
);

function workaiBefore(): string {
  return project("Workai", [
    `- [-] ${FEEGOW} #p1 ${SCHEDULED} ${TODAY}`,
    `  - [x] ${MAPPING} ${DONE} 2026-11-12`,
    `  - [-] ${CONSOLE}`,
    `  - [-] ${AGENDA}`,
    `  - [ ] ${PUBLISH}`,
    `  - [ ] ${CRM}`,
    `- [-] ${MEDWARE}`,
  ]);
}

function promoteInWorkai(content: string): string {
  return content
    .replace(`  - [-] ${AGENDA}\n`, "")
    .replace(`  - [ ] ${CRM}\n`, "")
    .replace(`- [-] ${MEDWARE}`, `- [-] ${CRM} ${SCHEDULED} ${TODAY}\n- [-] ${AGENDA} ${SCHEDULED} ${TODAY}\n- [-] ${MEDWARE}`);
}

describe("H3 case 1: a subtask promoted to a task moves its line in today's note", () => {
  it("moves the old child line to the top level once, with its checkbox, its suffix and its note, and inserts no copy", () => {
    const root = lab(
      { workai: workaiBefore() },
      {
        [TODAY]: dailyOf(TODAY, [
          `- [-] ${WK} - ${FEEGOW}`,
          `  - [-] ${CONSOLE}`,
          `  - [-] ${AGENDA} _Falta Deploy_`,
          `  - [ ] ${PUBLISH}`,
          "  - [ ] ligar pro Lucas antes",
          `  - [ ] ${CRM}`,
          "    - nota minha sobre o CRM",
        ]),
      },
    );
    const settings = useVault(root);
    settle(settings);
    editProject(root, "workai", promoteInWorkai);
    settle(settings);
    assert.deepEqual(focusLines(root), [
      `- [-] ${WK} - ${FEEGOW}`,
      `  - [-] ${CONSOLE}`,
      `  - [ ] ${PUBLISH}`,
      "  - [ ] ligar pro Lucas antes",
      `- [-] ${WK} - ${CRM}`,
      "  - nota minha sobre o CRM",
      `- [-] ${WK} - ${AGENDA} _Falta Deploy_`,
    ]);
    assert.ok(focusTitles(settings).includes(CRM));
    assertSettled(settings, root);
  });

  it("merges the copy the hub already wrote into one line at the project position", () => {
    const root = lab(
      { workai: promoteInWorkai(workaiBefore()) },
      {
        [TODAY]: dailyOf(TODAY, [
          `- [-] ${WK} - ${FEEGOW}`,
          `  - [ ] ${PUBLISH}`,
          `  - [-] ${CRM}`,
          `- [-] ${WK} - ${MEDWARE}`,
          `- [-] ${WK} - ${CRM}`,
        ]),
      },
    );
    const settings = useVault(root);
    settle(settings);
    const lines = focusLines(root);
    assert.equal(lines.filter((line) => line.includes(CRM)).length, 1);
    assert.deepEqual(lines.slice(0, 3), [`- [-] ${WK} - ${FEEGOW}`, `  - [ ] ${PUBLISH}`, `- [-] ${WK} - ${MEDWARE}`]);
    assert.ok(lines.includes(`- [-] ${WK} - ${CRM}`));
    assertSettled(settings, root);
  });
});

describe("H3 case 2: a phase added in the project nests the lines that were flat in the note", () => {
  it("creates the phase line once and moves the three lines under it, keeping the user note in place", () => {
    const root = lab(
      { equatorial: equatorialWithPhase(TODAY) },
      {
        [TODAY]: dailyOf(TODAY, [
          `- [-] ${EQ} - ${SERVERS}`,
          `  - [ ] ${ZERO_B}`,
          `  - [ ] ${BACKFILL}`,
          `  - [-] ${PROMOTE}`,
          "  - nota: medir antes de bloquear",
        ]),
      },
    );
    const settings = useVault(root);
    settle(settings);
    assert.deepEqual(focusLines(root), [
      `- [-] ${EQ} - ${SERVERS}`,
      `  - [-] ${PHASE}`,
      `    - [ ] ${ZERO_B}`,
      `    - [ ] ${BACKFILL}`,
      `    - [-] ${PROMOTE}`,
      "  - nota: medir antes de bloquear",
    ]);
    assertSettled(settings, root);
  });

  it("merges the copies of the real note of 17/11, keeps the project state and reports the copy that disagreed", () => {
    const root = lab(
      { equatorial: EQUATORIAL_AFTER },
      {
        [TODAY]: dailyOf(TODAY, [
          `- [x] ${EQ} - ${SERVERS}`,
          `  - [ ] ${ZERO_B}`,
          `  - [ ] ${BACKFILL}`,
          `  - [-] ${PROMOTE}`,
          `  - [x] ${PHASE}`,
          `    - [x] ${ZERO_B}`,
          `    - [ ] ${BACKFILL}`,
          `    - [x] ${PROMOTE}`,
          `  - [x] ${EXTEND}`,
          `- [-] ${EQ} - ${TRAIN}`,
          `  - [x] ${T3}`,
        ]),
      },
    );
    const settings = useVault(root);
    settle(settings);
    assert.deepEqual(focusLines(root), [
      `- [x] ${EQ} - ${SERVERS}`,
      `  - [x] ${PHASE}`,
      `    - [x] ${ZERO_B}`,
      `    - [x] ${PROMOTE}`,
      `  - [x] ${EXTEND}`,
      `- [ ] ${EQ} - ${BACKFILL}`,
      `- [-] ${EQ} - ${TRAIN}`,
      `  - [x] ${T3}`,
    ]);
    const reported = (today.readToday(settings, TODAY).outOfSync ?? []).map((item) => [item.taskTitle, item.dailyCheckbox]);
    assert.deepEqual(reported.sort(), [
      [ZERO_B, "todo"],
      [PROMOTE, "doing"],
    ]);
    assert.ok(focusTitles(settings).includes(BACKFILL));
    assertSettled(settings, root);
  });
});

describe("H3 case 3: a subtask moved out of a finished task stays visible", () => {
  it("moves its line to the top level and lists it in the focus", () => {
    const root = lab(
      { equatorial: equatorialWithPhase(TODAY) },
      {
        [TODAY]: dailyOf(TODAY, [`- [-] ${EQ} - ${SERVERS}`, `  - [-] ${PHASE}`, `    - [ ] ${ZERO_B}`, `    - [ ] ${BACKFILL}`, `    - [ ] ${PROMOTE}`]),
      },
    );
    const settings = useVault(root);
    settle(settings);
    write(root, "projects/equatorial.md", EQUATORIAL_AFTER);
    settle(settings);
    const lines = focusLines(root);
    assert.equal(lines.filter((line) => line.includes(BACKFILL)).length, 1);
    assert.ok(lines.includes(`- [ ] ${EQ} - ${BACKFILL}`), lines.join("\n"));
    assert.equal(lines.indexOf(`- [ ] ${EQ} - ${BACKFILL}`), lines.findIndex((line, index) => index > 0 && !line.startsWith(" ")));
    assert.ok(focusTitles(settings).includes(BACKFILL));
    assertSettled(settings, root);
  });
});

describe("H3 case 4: a title changed in the project renames the line", () => {
  it("renames the line to the project title and reports its checkbox when it disagrees", () => {
    const root = lab({ equatorial: EQUATORIAL_AFTER }, { [TODAY]: dailyOf(TODAY, [`- [-] ${EQ} - ${TRAIN}`, `  - [x] ${T3}`, `  - [ ] ${DATASET_NOTE}`]) });
    const settings = useVault(root);
    settle(settings);
    assert.deepEqual(focusLines(root).slice(0, 3), [`- [-] ${EQ} - ${TRAIN}`, `  - [x] ${T3}`, `  - [ ] ${DATASET}`]);
    const reported = (today.readToday(settings, TODAY).outOfSync ?? []).map((item) => item.taskTitle);
    assert.ok(reported.includes(DATASET), reported.join("|"));
    assertSettled(settings, root);
  });
});

describe("H3: yesterday is never restructured", () => {
  it("leaves the flat lines of yesterday byte for byte", () => {
    const flat = dailyOf(YESTERDAY, [`- [-] ${EQ} - ${SERVERS}`, `  - [ ] ${ZERO_B}`, `  - [ ] ${BACKFILL}`, `  - [-] ${PROMOTE}`]);
    const root = lab({ equatorial: equatorialWithPhase(YESTERDAY) }, { [YESTERDAY]: flat });
    const settings = useVault(root);
    settle(settings, YESTERDAY);
    assert.equal(read(root, dailyRel(YESTERDAY)), flat);
  });
});

describe("H3: no path writes a copy of a line the note already has", () => {
  const RELEASE = "Release the new version";
  const PHASE_A = "Phase A of the release";
  const CHANGELOG = "Write the changelog for the release";
  const OTHER = "Other task of the day";

  it("Add to focus moves the line it finds under another parent instead of adding one", () => {
    const alpha = project("Alpha", [`- [ ] ${RELEASE} ${SCHEDULED} ${TODAY}`, `  - [ ] ${PHASE_A}`, `    - [ ] ${CHANGELOG}`]);
    const root = lab({ alpha }, { [TODAY]: dailyOf(TODAY, [`- [ ] [[alpha|Alpha]] - ${RELEASE}`, `  - [ ] ${CHANGELOG}`]) });
    const settings = useVault(root);
    settle(settings);
    const task = taskIn(settings, "alpha", CHANGELOG);
    today.todayApi.schedule(settings, { projectId: "alpha", line: task.line, raw: task.raw, date: TODAY });
    settle(settings);
    assert.deepEqual(focusLines(root), [`- [ ] [[alpha|Alpha]] - ${RELEASE}`, `  - [ ] ${PHASE_A}`, `    - [ ] ${CHANGELOG}`]);
    assert.equal(taskIn(settings, "alpha", CHANGELOG).scheduled, TODAY);
  });

  it("Plan subtasks moves the line from the wrong parent instead of adding one", () => {
    const alpha = project("Alpha", [`- [ ] ${RELEASE} ${SCHEDULED} ${TODAY}`, `  - [ ] ${CHANGELOG}`, `- [ ] ${OTHER} ${SCHEDULED} ${TODAY}`]);
    const root = lab({ alpha }, { [TODAY]: dailyOf(TODAY, [`- [ ] [[alpha|Alpha]] - ${RELEASE}`, `- [ ] [[alpha|Alpha]] - ${OTHER}`, `  - [ ] ${CHANGELOG}`]) });
    const settings = useVault(root);
    settle(settings);
    const task = taskIn(settings, "alpha", CHANGELOG);
    today.todayApi.planSubtask(settings, TODAY, { projectId: "alpha", line: task.line, raw: task.raw, planned: true });
    settle(settings);
    assert.deepEqual(focusLines(root), [`- [ ] [[alpha|Alpha]] - ${RELEASE}`, `  - [ ] ${CHANGELOG}`, `- [ ] [[alpha|Alpha]] - ${OTHER}`]);
  });

  it("an outliner reparent in Tasks moves the line under the new parent", () => {
    const alpha = project("Alpha", [`- [ ] ${RELEASE} ${SCHEDULED} ${TODAY}`, `  - [ ] ${CHANGELOG} ${SCHEDULED} ${TODAY}`, `- [ ] ${OTHER} ${SCHEDULED} ${TODAY}`]);
    const root = lab({ alpha }, { [TODAY]: dailyOf(TODAY, [`- [ ] [[alpha|Alpha]] - ${RELEASE}`, `  - [ ] ${CHANGELOG}`, `- [ ] [[alpha|Alpha]] - ${OTHER}`]) });
    const settings = useVault(root);
    settle(settings);
    const task = taskIn(settings, "alpha", CHANGELOG);
    const other = taskIn(settings, "alpha", OTHER);
    board.reparentBoardTask(settings, { projectId: "alpha", line: task.line, raw: task.raw, parent: { line: other.line, raw: other.raw } });
    settle(settings);
    assert.deepEqual(focusLines(root), [`- [ ] [[alpha|Alpha]] - ${RELEASE}`, `- [ ] [[alpha|Alpha]] - ${OTHER}`, `  - [ ] ${CHANGELOG}`]);
    assertSettled(settings, root);
  });

  it("a task created after its line was typed under another task takes that line", () => {
    const alpha = project("Alpha", [`- [ ] ${RELEASE} ${SCHEDULED} ${TODAY}`]);
    const root = lab({ alpha }, { [TODAY]: dailyOf(TODAY, [`- [ ] [[alpha|Alpha]] - ${RELEASE}`, `  - [ ] ${CHANGELOG}`]) });
    const settings = useVault(root);
    settle(settings);
    board.createBoardTask(settings, { projectId: "alpha", title: CHANGELOG, scheduled: TODAY });
    settle(settings);
    const lines = focusLines(root);
    assert.equal(lines.filter((line) => line.includes(CHANGELOG)).length, 1, lines.join("\n"));
    assert.deepEqual(lines, [`- [ ] [[alpha|Alpha]] - ${RELEASE}`, `- [ ] [[alpha|Alpha]] - ${CHANGELOG}`]);
    assertSettled(settings, root);
  });

  it("a line that could be two moved tasks is surfaced with the reason and never copied", () => {
    const alpha = project("Alpha", [
      `- [ ] ${RELEASE}`,
      `  - [ ] ${CHANGELOG} ${SCHEDULED} ${TODAY}`,
      `- [ ] ${PHASE_A}`,
      `  - [ ] ${CHANGELOG} ${SCHEDULED} ${TODAY}`,
      `- [ ] ${OTHER} ${SCHEDULED} ${TODAY}`,
    ]);
    const root = lab({ alpha }, { [TODAY]: dailyOf(TODAY, [`- [ ] [[alpha|Alpha]] - ${OTHER}`, `  - [ ] ${CHANGELOG}`]) });
    const settings = useVault(root);
    settle(settings);
    assert.equal(focusLines(root).filter((line) => line.includes(CHANGELOG)).length, 1);
    const moved = today.readToday(settings, TODAY).ambiguous.filter((item) => item.reason === "moved");
    assert.equal(moved.length, 2);
  });
});
