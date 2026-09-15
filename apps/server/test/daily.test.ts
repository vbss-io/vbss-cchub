import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { makeSandbox, startServer, waitFor, type RunningServer, type Sandbox } from "./helpers.js";
import type { DelegationSettings } from "../src/delegation-types.js";

const dataDir = mkdtempSync(join(tmpdir(), "cch-daily-store-"));
process.env.HUB_DATA_DIR = dataDir;
delete process.env.HUB_RESOURCE_DIR;
delete process.env.HUB_WORKSPACES_ROOT;
delete process.env.HUB_EDITOR;
delete process.env.HUB_SECOND_BRAIN;

type Store = typeof import("../src/delegation-store.js");
type Daily = typeof import("../src/daily.js");
type Sse = typeof import("../src/sse.js");
let store: Store;
let daily: Daily;
let sse: Sse;

before(async () => {
  store = await import("../src/delegation-store.js");
  daily = await import("../src/daily.js");
  sse = await import("../src/sse.js");
});

const defaultDaily: DelegationSettings["daily"] = {
  dir: null,
  template: null,
  prompt: null,
  runner: "claude",
  headings: { focus: "Focus", meetings: "Meetings", sessions: "Sessions" },
  closedKey: "closed",
  wikilinks: false,
};

function fixtureSettings(root: string, overrides: Partial<DelegationSettings> = {}): DelegationSettings {
  return {
    workspacesRoot: null,
    editorCommand: "code",
    secondBrainRoot: root,
    autonomy: "full",
    ownerName: "tester",
    runTimeoutMinutes: 60,
    features: { daily: true },
    daily: defaultDaily,
    ...overrides,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const REFERENCE_DIARY = `---
type: diario
created: 2026-09-14
updated: 2026-09-14
tags: [diario]
---

# 2026-09-14

> **Briefing (do trail de 11→14/09):**
>
> **Últimos dias (o que andou):**
>
> - **11/09 (Space):** Equatorial resource-limits em prod + rollout 100% (dev/qa/prd), OOMKill qa resolvido, 9 zumbis no \`default\` limpos (469bd15), TLS DH1024 paliativo na sisfeedback-api; Workai console 1.6.3/1.6.4 (reset-on-load + dedup), Lia reply de annotation (11/13) + batch IQ 92.6%; Universum fix de evidence (4f7e3e59).
> - **12–13/09 (VBSS, fim de semana):** faxina de disco (~44 GB liberados, nexus removido, \`.aws/.azure/.kube\` migrados pros workspaces), CC Hub build #75 (worktree/claim/portas/ngrok/Codex), **sernio** entregue via foreman (server Express + web React, 317 testes verdes, mock Vanguarda) — falta E2E com \`.env\` real.
> - **14/09 (manhã):** AWS Workai acessível via profile \`workai-bedrock\` (isolado no workspace).
>
> **Aberto que importa:**
>
> - Equatorial — **contagens do Murilo (13/09):** 57 KBs veiados, 227 ECRs, Inference Profiles por IA provisionada → revisar
> - Equatorial — GeoServer **prod** (config/check) + feedbacks do Will; app-path editável prd rollout ainda não confirmado
> - Workai — Cora: annotation da Duda + batch IQ 134 (não tocada desde 08/09)
> - Prever — acesso ao **banco TOTVS** do cliente novo (jump RDP, credencial pendente Luis Fillipe)
> - sernio — E2E com \`.env\` real (mock Vanguarda já validado)
>
> **Reuniões:** 09:30 Today (Murilo) · 10:00 Dra. Michely — subir assistente na Meta (Vivi).
>
> **Teams:** Murilo (PLANET-EQUATORIAL, 13/09): "revisar 57 kb veiados no dev factory", "227 ecr", "inference profiles criados para cada ia provisionada".
>
> **Gameficare:** 0 cards teus, nada travado. **Inbox:** 10. **Revisão:** 52 dias sem weekly-review — roda hoje?

## Foco de hoje

- [x] [[Equatorial]] - Config/Check GeoServer Produção + ajustes feedbacks do Will
  - Aguardar devolutiva se é necessário mais updates
  - Entender o erro de rede que comprometeu a resolução de secrets pros deployments
    - IPs internos pinados, durante uma rotação a VM do gitlab parou de resolver os ips de plataforma, sem conseguir resolver secrets e sem dar o callback de deploy concluído
- [x] [[equatorial|Equatorial]] - Analisar contagens de recursos: 57 KBs, 227 ECRs e Inference Profiles
  - [ ] Migração e limpeza de projetos que não utilizam IA/KB, migrando pro on-demmand e removendo AI/Vision/KB - **Continuar amanhã**
- [x] [[equatorial|Equatorial]] - Excluir apps EQTL Agiltec/PAM - Portal de Agendamentos
- [x] [[equatorial|Equatorial]] - Call de Suporte Guilherme/Aureliano sobre integração de um backend em projetos com front-ends existentes
- [x] [[equatorial|Equatorial]] - View de secrets para membros, read-only sem o valor
- [x] [[equatorial|Equatorial]] - Descer permissão de import de grupos Entra de admin para operador
- [x] [[equatorial|Equatorial]] - Cobrar Luiz EQTL usuários Rafael/Livia
  - Sinalizou que já tinah pedido, que ia ver, mas não retornou sobre o assunto

- [x] [[workai|Workai]] - Diagnóstico de erro Cadastro Incorporado - Michely Carvalho
  - Sem conclusões definitivas sobre o erro, a suposição é que o número do WhatsApp possa estar atrelado a um WABA de terceiros sem acesso do cliente.
- [x] [[workai|Workai]] - Check de exports XLSX + número de usuários por assistente
  - Report/Tokens/Assistant Tokens alinhados com valores corretos
- [x] [[workai|Workai]] - Check de custos AWS × valor registrado no Console
  - Valores corretos, melhorias de cache performance para AWS pra tentar minimizar os custos
- [x] [[workai|Workai]] - Implementação de echoes do cadastro incorporado em coexistence
  - Console/Clinics renderiza mensagens enviadas direto do app do WhatsApp com badge de app e acionando IH

- [x] [[clientes|Workai]] - Analisar/Implementar Boom Fit / Academia Foguetes
  - Seguir com inicio da implementação amanhã

- [ ] [[di-stefano|Distefano]] - Evoluir auth da aplicação analisando Docs

## Reuniões

- 09:30 - Today (Murilo)
- 10:00 - Dra. Michely — subir a assistente na Meta (Vivi)

## Capturas do dia

-

## Promovido (keeper)

-

## Sessões

-
`;

describe("daily settings", () => {
  it("defaults features.daily off and merges nested daily patches", () => {
    const defaults = store.getSettings();
    assert.deepEqual(defaults.features, { daily: false });
    assert.deepEqual(defaults.daily, defaultDaily);

    const afterFeature = store.updateSettings({ features: { daily: true } });
    assert.equal(afterFeature.features.daily, true);
    assert.deepEqual(afterFeature.daily, defaultDaily);

    const afterPrompt = store.updateSettings({ daily: { prompt: "custom prompt" } });
    assert.equal(afterPrompt.daily.prompt, "custom prompt");
    assert.equal(afterPrompt.features.daily, true);
    assert.equal(afterPrompt.daily.dir, null);

    const afterRest = store.updateSettings({ daily: { runner: "codex", dir: "diario2" } });
    assert.equal(afterRest.daily.runner, "codex");
    assert.equal(afterRest.daily.dir, "diario2");
    assert.equal(afterRest.daily.prompt, "custom prompt");
  });

  it("merges headings, closedKey and wikilinks individually and defaults old rows", () => {
    const before = store.updateSettings({ daily: { headings: { focus: "Foco de hoje" } } });
    assert.equal(before.daily.headings.focus, "Foco de hoje");
    assert.equal(before.daily.headings.meetings, "Meetings");
    assert.equal(before.daily.headings.sessions, "Sessions");
    assert.equal(before.daily.closedKey, "closed");
    assert.equal(before.daily.wikilinks, false);

    const after = store.updateSettings({ daily: { headings: { meetings: "Reuniões" }, closedKey: "fechado", wikilinks: true } });
    assert.equal(after.daily.headings.focus, "Foco de hoje");
    assert.equal(after.daily.headings.meetings, "Reuniões");
    assert.equal(after.daily.closedKey, "fechado");
    assert.equal(after.daily.wikilinks, true);
  });
});

describe("dailyFile resolution", () => {
  const root = mkdtempSync(join(tmpdir(), "cch-daily-file-"));

  before(() => {
    mkdirSync(join(root, "daily", "2026-08"), { recursive: true });
    writeFileSync(join(root, "daily", "2026-08", "2026-08-27.md"), "# archived");
    writeFileSync(join(root, "daily", "2026-09-15.md"), "# today");
  });

  after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("resolves an existing root-level diary", () => {
    assert.equal(daily.dailyFile(fixtureSettings(root), "2026-09-15"), join(root, "daily", "2026-09-15.md"));
  });

  it("resolves an archived diary through the recursive lookup", () => {
    assert.equal(daily.dailyFile(fixtureSettings(root), "2026-08-27"), join(root, "daily", "2026-08", "2026-08-27.md"));
  });

  it("falls back to the daily dir for a date with no diary yet", () => {
    assert.equal(daily.dailyFile(fixtureSettings(root), "2026-09-20"), join(root, "daily", "2026-09-20.md"));
  });

  it("honors a custom daily.dir, relative to root", () => {
    const settings = fixtureSettings(root, { daily: { ...defaultDaily, dir: "custom-daily" } });
    assert.equal(daily.dailyFile(settings, "2026-09-20"), join(root, "custom-daily", "2026-09-20.md"));
  });

  it("resolves an archived diary nested one level under a non-month-named subfolder", () => {
    mkdirSync(join(root, "daily", "misc"), { recursive: true });
    writeFileSync(join(root, "daily", "misc", "2026-07-04.md"), "# nested");
    assert.equal(daily.dailyFile(fixtureSettings(root), "2026-07-04"), join(root, "daily", "misc", "2026-07-04.md"));
  });

  it("resolves the template path with the built-in fallback", () => {
    assert.equal(daily.dailyTemplatePath(fixtureSettings(root)), null);
    mkdirSync(join(root, "_templates"), { recursive: true });
    writeFileSync(join(root, "_templates", "daily.md"), "# {{date}}");
    assert.equal(daily.dailyTemplatePath(fixtureSettings(root)), join(root, "_templates", "daily.md"));
  });
});

describe("custom daily.dir (journal) resolution", () => {
  const root = mkdtempSync(join(tmpdir(), "cch-daily-journal-"));
  const settings = fixtureSettings(root, { daily: { ...defaultDaily, dir: "journal" } });

  before(() => {
    mkdirSync(join(root, "journal", "2026-08"), { recursive: true });
    writeFileSync(join(root, "journal", "2026-08", "2026-08-30.md"), "# archived in journal");
    writeFileSync(join(root, "journal", "2026-09-01.md"), "# journal today");
  });

  after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("reads an existing diary from inside journal/", () => {
    assert.equal(daily.dailyFile(settings, "2026-09-01"), join(root, "journal", "2026-09-01.md"));
    const read = daily.readDaily(settings, "2026-09-01");
    assert.equal(read.exists, true);
    assert.equal(read.content, "# journal today");
  });

  it("resolves an archived diary nested one level inside journal/", () => {
    assert.equal(daily.dailyFile(settings, "2026-08-30"), join(root, "journal", "2026-08", "2026-08-30.md"));
  });

  it("lists dates scanning journal/ and its immediate subfolders", () => {
    assert.deepEqual(daily.listDiaryDates(settings), ["2026-09-01", "2026-08-30"]);
  });

  it("finds yesterday inside journal/", () => {
    assert.equal(daily.findYesterday(settings, "2026-09-15"), "2026-09-01");
  });
});

describe("template and prompt rendering", () => {
  it("renders {{date}} in the built-in template", () => {
    const rendered = daily.renderTemplate(daily.BUILT_IN_TEMPLATE, "2026-09-15");
    assert.match(rendered, /created: 2026-09-15/);
    assert.match(rendered, /# 2026-09-15/);
    assert.doesNotMatch(rendered, /\{\{date\}\}/);
  });

  it("renders every placeholder of the default prompt", () => {
    const rendered = daily.renderDailyPrompt(daily.DEFAULT_DAILY_PROMPT, {
      date: "2026-09-15",
      file: "/vault/daily/2026-09-15.md",
      root: "/vault",
      template: "none",
      focus: "ship the daily tab",
      sessions: "- task a · claude-code · /repo",
      yesterday: "2026-09-14",
    });
    assert.doesNotMatch(rendered, /\{\{/);
    assert.match(rendered, /2026-09-15/);
    assert.match(rendered, /2026-09-14/);
    assert.match(rendered, /ship the daily tab/);
  });

  it("finds the most recent diary before a date through the recursive lookup", () => {
    const root = mkdtempSync(join(tmpdir(), "cch-daily-yday-"));
    mkdirSync(join(root, "daily", "2026-08"), { recursive: true });
    writeFileSync(join(root, "daily", "2026-08", "2026-08-30.md"), "#");
    writeFileSync(join(root, "daily", "2026-09-01.md"), "#");
    const settings = fixtureSettings(root);
    assert.equal(daily.findYesterday(settings, "2026-09-15"), "2026-09-01");
    assert.equal(daily.findYesterday(settings, "2026-08-31"), "2026-08-30");
    assert.equal(daily.findYesterday(settings, "2020-01-01"), null);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
});

describe("parseTaskLines", () => {
  it("finds every checkbox item at any depth in the reference diary", () => {
    const tasks = daily.parseTaskLines(REFERENCE_DIARY);
    assert.equal(tasks.length, 14);
    assert.equal(tasks.filter((task) => task.depth === 0).length, 13);
  });

  it("reports depth and raw checkbox-stripped text for a top-level and a nested item", () => {
    const tasks = daily.parseTaskLines(REFERENCE_DIARY);
    const top = tasks.find((task) => task.line === 33)!;
    assert.equal(top.depth, 0);
    assert.equal(top.checked, true);
    assert.equal(top.text, "[[Equatorial]] - Config/Check GeoServer Produção + ajustes feedbacks do Will");
    assert.equal(top.raw, "- [x] [[Equatorial]] - Config/Check GeoServer Produção + ajustes feedbacks do Will");

    const nested = tasks.find((task) => task.line === 38)!;
    assert.equal(nested.depth, 1);
    assert.equal(nested.checked, false);
    assert.equal(nested.text, "Migração e limpeza de projetos que não utilizam IA/KB, migrando pro on-demmand e removendo AI/Vision/KB - **Continuar amanhã**");
  });

  it("treats tabs as 4 spaces and 2 spaces as one depth level", () => {
    const tasks = daily.parseTaskLines("- [ ] top\n  - [ ] two spaces\n\t- [ ] one tab\n\t\t- [ ] two tabs");
    assert.deepEqual(
      tasks.map((task) => task.depth),
      [0, 1, 2, 4],
    );
  });
});

describe("taskBlock", () => {
  it("returns a task with nested sub-bullets, stopping at the next depth-0 sibling", () => {
    const block = daily.taskBlock(REFERENCE_DIARY, 33);
    assert.equal(
      block,
      "- [x] [[Equatorial]] - Config/Check GeoServer Produção + ajustes feedbacks do Will\n" +
        "  - Aguardar devolutiva se é necessário mais updates\n" +
        "  - Entender o erro de rede que comprometeu a resolução de secrets pros deployments\n" +
        "    - IPs internos pinados, durante uma rotação a VM do gitlab parou de resolver os ips de plataforma, sem conseguir resolver secrets e sem dar o callback de deploy concluído",
    );
  });

  it("stops before a blank line followed by the next sibling, dropping trailing blanks", () => {
    const block = daily.taskBlock(REFERENCE_DIARY, 43);
    assert.equal(
      block,
      "- [x] [[equatorial|Equatorial]] - Cobrar Luiz EQTL usuários Rafael/Livia\n" +
        "  - Sinalizou que já tinah pedido, que ia ver, mas não retornou sobre o assunto",
    );
  });

  it("returns just the line for a task with no nested content", () => {
    const block = daily.taskBlock(REFERENCE_DIARY, 39);
    assert.equal(block, "- [x] [[equatorial|Equatorial]] - Excluir apps EQTL Agiltec/PAM - Portal de Agendamentos");
  });
});

describe("setTaskChecked", () => {
  it("flips only the target line and keeps everything else, LF", () => {
    const source = "- [ ] a\n- [ ] b\n- [ ] c";
    const next = daily.setTaskChecked(source, 1, true);
    assert.equal(next, "- [ ] a\n- [x] b\n- [ ] c");
  });

  it("preserves CRLF line endings elsewhere in the file", () => {
    const source = "# title\r\n- [ ] a\r\n- [ ] b\r\n- [ ] c";
    const next = daily.setTaskChecked(source, 3, true);
    assert.equal(next, "# title\r\n- [ ] a\r\n- [ ] b\r\n- [x] c");
  });

  it("leaves the source unchanged for an out-of-range index", () => {
    const source = "- [ ] a\n- [ ] b";
    assert.equal(daily.setTaskChecked(source, 9, true), source);
  });
});

describe("readFrontmatterKey / setFrontmatterKey", () => {
  it("reads an existing key and returns null for one that is absent", () => {
    assert.equal(daily.readFrontmatterKey(REFERENCE_DIARY, "type"), "diario");
    assert.equal(daily.readFrontmatterKey(REFERENCE_DIARY, "closed"), null);
  });

  it("adds a missing key before the closing marker and preserves the rest, LF", () => {
    const next = daily.setFrontmatterKey(REFERENCE_DIARY, "closed", "2026-09-15");
    assert.equal(daily.readFrontmatterKey(next, "closed"), "2026-09-15");
    assert.equal(daily.readFrontmatterKey(next, "type"), "diario");
    assert.match(next, /## Foco de hoje/);
    assert.match(next, /^---\ntype: diario\ncreated: 2026-09-14\nupdated: 2026-09-14\ntags: \[diario\]\nclosed: 2026-09-15\n---\n/);
  });

  it("replaces an existing key in place", () => {
    const withKey = daily.setFrontmatterKey(REFERENCE_DIARY, "type", "journal");
    assert.equal(daily.readFrontmatterKey(withKey, "type"), "journal");
  });

  it("creates the frontmatter block when absent, preserving CRLF", () => {
    const source = "# title\r\nbody";
    const next = daily.setFrontmatterKey(source, "closed", "2026-09-15");
    assert.equal(next, "---\r\nclosed: 2026-09-15\r\n---\r\n\r\n# title\r\nbody");
    assert.equal(daily.readFrontmatterKey(next, "closed"), "2026-09-15");
  });
});

const PT_DIARY_TEMPLATE =
  "---\ntype: diario\ncreated: {{date}}\nupdated: {{date}}\ntags: [diario]\n---\n\n# {{date}}\n\n" +
  "## Foco de hoje\n\n- [ ] \n\n## Reuniões\n\n-\n\n## Capturas do dia\n\n-\n\n## Promovido (keeper)\n\n-\n\n## Sessões\n\n-\n";

describe("composeDaily", () => {
  const headings: DelegationSettings["daily"]["headings"] = { focus: "Focus", meetings: "Meetings", sessions: "Sessions" };

  it("preserves every template blank line and replaces placeholders in place against the Portuguese template", () => {
    const ptHeadings: DelegationSettings["daily"]["headings"] = { focus: "Foco de hoje", meetings: "Reuniões", sessions: "Sessões" };
    const content = daily.composeDaily(
      PT_DIARY_TEMPLATE,
      {
        briefing: "line one\nline two",
        focus: [
          { project: "di-stefano", text: "Evoluir auth" },
          { project: "Equatorial", text: "item" },
        ],
        meetings: ["09:30 - Today (Murilo)"],
        sessions: [],
      },
      { date: "2026-09-15", headings: ptHeadings, wikilinks: true },
    );
    assert.equal(
      content,
      "---\ntype: diario\ncreated: 2026-09-15\nupdated: 2026-09-15\ntags: [diario]\n---\n\n" +
        "# 2026-09-15\n\n> **Briefing:**\n>\n> line one\n> line two\n\n" +
        "## Foco de hoje\n\n- [ ] [[di-stefano]] - Evoluir auth\n\n- [ ] [[Equatorial]] - item\n\n" +
        "## Reuniões\n\n- 09:30 - Today (Murilo)\n\n" +
        "## Capturas do dia\n\n-\n\n## Promovido (keeper)\n\n-\n\n## Sessões\n\n-\n",
    );
  });

  it("keeps a single '-' placeholder for sessions, never duplicating it, when there are no sessions", () => {
    const ptHeadings: DelegationSettings["daily"]["headings"] = { focus: "Foco de hoje", meetings: "Reuniões", sessions: "Sessões" };
    const content = daily.composeDaily(
      PT_DIARY_TEMPLATE,
      { focus: [{ project: null, text: "x" }], meetings: [], sessions: [] },
      { date: "2026-09-15", headings: ptHeadings, wikilinks: false },
    );
    assert.match(content, /## Sessões\n\n-\n$/);
    assert.doesNotMatch(content, /## Sessões\n\n-\n\n-/);
  });

  it("renders focus, meetings and sessions into the built-in template", () => {
    const content = daily.composeDaily(
      daily.BUILT_IN_TEMPLATE,
      {
        focus: [{ project: "equatorial", text: "ship the daily tab" }],
        meetings: ["09:30 Today (Murilo)"],
        sessions: [{ sessionId: "s1", title: "task a", client: "claude-code", cwd: "/repo", status: "completed", startedAt: 0, updatedAt: 0 }],
      },
      { date: "2026-09-15", headings, wikilinks: false },
    );
    assert.match(content, /# 2026-09-15/);
    assert.match(content, /## Focus\n- \[ \] equatorial - ship the daily tab/);
    assert.match(content, /## Meetings\n- 09:30 Today \(Murilo\)/);
    assert.match(content, /## Sessions\n- task a · claude-code/);
  });

  it("wraps project labels as wikilinks when enabled, and omits them entirely when null", () => {
    const withWikilinks = daily.composeDaily(
      daily.BUILT_IN_TEMPLATE,
      { focus: [{ project: "equatorial", text: "item a" }], meetings: [], sessions: [] },
      { date: "2026-09-15", headings, wikilinks: true },
    );
    assert.match(withWikilinks, /- \[ \] \[\[equatorial\]\] - item a/);

    const withoutProject = daily.composeDaily(
      daily.BUILT_IN_TEMPLATE,
      { focus: [{ project: null, text: "item b" }], meetings: [], sessions: [] },
      { date: "2026-09-15", headings, wikilinks: true },
    );
    assert.match(withoutProject, /## Focus\n- \[ \] item b/);
  });

  it("keeps the placeholders when meetings and sessions are empty", () => {
    const content = daily.composeDaily(
      daily.BUILT_IN_TEMPLATE,
      { focus: [{ project: null, text: "solo item" }], meetings: [], sessions: [] },
      { date: "2026-09-15", headings, wikilinks: false },
    );
    assert.match(content, /## Meetings\n-\n/);
    assert.match(content, /## Sessions\n-\n/);
  });

  it("groups consecutive focus items by project with a blank line between groups", () => {
    const content = daily.composeDaily(
      daily.BUILT_IN_TEMPLATE,
      {
        focus: [
          { project: "equatorial", text: "item a" },
          { project: "equatorial", text: "item b" },
          { project: "workai", text: "item c" },
        ],
        meetings: [],
        sessions: [],
      },
      { date: "2026-09-15", headings, wikilinks: false },
    );
    assert.match(
      content,
      /## Focus\n- \[ \] equatorial - item a\n- \[ \] equatorial - item b\n\n- \[ \] workai - item c/,
    );
  });

  it("uses a carry-over block verbatim, forcing the checkbox open", () => {
    const block = daily.taskBlock(REFERENCE_DIARY, 33);
    const content = daily.composeDaily(
      daily.BUILT_IN_TEMPLATE,
      { focus: [{ project: "equatorial", text: "ignored when block is set", block }], meetings: [], sessions: [] },
      { date: "2026-09-15", headings, wikilinks: false },
    );
    assert.match(content, /## Focus\n- \[ \] \[\[Equatorial\]\] - Config\/Check GeoServer Produção/);
    assert.match(content, /ips de plataforma, sem conseguir resolver secrets/);
  });

  it("inserts a briefing blockquote right after the H1, and skips it entirely when empty", () => {
    const withBriefing = daily.composeDaily(
      daily.BUILT_IN_TEMPLATE,
      { briefing: "line one\nline two", focus: [{ project: null, text: "x" }], meetings: [], sessions: [] },
      { date: "2026-09-15", headings, wikilinks: false },
    );
    assert.match(withBriefing, /# 2026-09-15\n\n> \*\*Briefing:\*\*\n>\n> line one\n> line two\n\n## Focus/);

    const withoutBriefing = daily.composeDaily(
      daily.BUILT_IN_TEMPLATE,
      { briefing: "   ", focus: [{ project: null, text: "x" }], meetings: [], sessions: [] },
      { date: "2026-09-15", headings, wikilinks: false },
    );
    assert.doesNotMatch(withoutBriefing, /Briefing/);
  });

  it("matches headings case-insensitively against a Portuguese template", () => {
    const ptTemplate = `# {{date}}

## foco de hoje
-

## reuniões
-

## sessões
-
`;
    const ptHeadings: DelegationSettings["daily"]["headings"] = { focus: "Foco de hoje", meetings: "Reuniões", sessions: "Sessões" };
    const content = daily.composeDaily(
      ptTemplate,
      { focus: [{ project: "equatorial", text: "item a" }], meetings: ["09:30 Today"], sessions: [] },
      { date: "2026-09-15", headings: ptHeadings, wikilinks: false },
    );
    assert.match(content, /## foco de hoje\n- \[ \] equatorial - item a/);
    assert.match(content, /## reuniões\n- 09:30 Today/);
    assert.match(content, /## sessões\n-\n/);
  });

  it("appends a section at the end when its heading is missing from the template", () => {
    const content = daily.composeDaily(
      `# {{date}}\n\n## Focus\n-\n`,
      { focus: [], meetings: ["09:30 Today"], sessions: [] },
      { date: "2026-09-15", headings, wikilinks: false },
    );
    assert.match(content, /## Meetings\n- 09:30 Today/);
  });
});

describe("hash comparison helper", () => {
  it("is deterministic and content-sensitive", () => {
    assert.equal(daily.hashDailyContent("same"), daily.hashDailyContent("same"));
    assert.notEqual(daily.hashDailyContent("a"), daily.hashDailyContent("b"));
  });
});

describe("read/write round-trip", () => {
  const root = mkdtempSync(join(tmpdir(), "cch-daily-rw-"));

  after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("reports missing files, then writes atomically and reads back with mtime", () => {
    const settings = fixtureSettings(root);
    const missing = daily.readDaily(settings, "2026-09-15");
    assert.equal(missing.exists, false);
    assert.equal(missing.content, "");
    assert.equal(missing.updatedAt, null);

    const written = daily.writeDaily(settings, "2026-09-15", "# hello\n");
    assert.equal(written.path, join(root, "daily", "2026-09-15.md"));
    assert.ok(existsSync(written.path));
    assert.equal(readFileSync(written.path, "utf8"), "# hello\n");

    const read = daily.readDaily(settings, "2026-09-15");
    assert.equal(read.exists, true);
    assert.equal(read.content, "# hello\n");
    assert.equal(read.updatedAt, written.updatedAt);
  });

  it("does not conflict when baseUpdatedAt matches the hub's own last write", () => {
    const settings = fixtureSettings(root);
    const first = daily.writeDaily(settings, "2026-09-17", "hub v1");
    const second = daily.writeDaily(settings, "2026-09-17", "hub v2", first.updatedAt);
    assert.equal(daily.readDaily(settings, "2026-09-17").content, "hub v2");
    assert.ok(second.updatedAt >= first.updatedAt);
  });

  it("throws a conflict when the disk changed since baseUpdatedAt", async () => {
    const settings = fixtureSettings(root);
    const initial = daily.writeDaily(settings, "2026-09-16", "hub v1");
    await sleep(20);
    writeFileSync(join(root, "daily", "2026-09-16.md"), "edited outside the hub");
    assert.throws(
      () => daily.writeDaily(settings, "2026-09-16", "hub v2", initial.updatedAt),
      (err: unknown) => {
        assert.ok(err instanceof daily.DailyConflictError);
        assert.equal((err as InstanceType<Daily["DailyConflictError"]>).content, "edited outside the hub");
        return true;
      },
    );
    assert.equal(readFileSync(join(root, "daily", "2026-09-16.md"), "utf8"), "edited outside the hub");
  });
});

describe("watcher", () => {
  const root = mkdtempSync(join(tmpdir(), "cch-daily-watch-"));

  before(() => mkdirSync(join(root, "daily"), { recursive: true }));

  after(() => {
    daily.stopDailyWatch();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("broadcasts a disk-sourced daily event for an external write and suppresses echoes of the hub's own write", async () => {
    const settings = fixtureSettings(root);
    const events: { date: string; updatedAt: number; source: string; writeId?: string | null }[] = [];
    const unsubscribe = sse.onBroadcast((event, data) => {
      if (event === "daily") events.push(data as { date: string; updatedAt: number; source: string; writeId?: string | null });
    });

    daily.watchDaily(settings);
    writeFileSync(join(root, "daily", "2026-09-01.md"), "external content");

    const seen = await waitFor(async () => (events.length > 0 ? events[0] : null), 5000);
    assert.equal(seen.date, "2026-09-01");
    assert.equal(seen.source, "disk");

    events.length = 0;
    daily.writeDaily(settings, "2026-09-02", "written by hub");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.source, "hub");
    assert.equal(events[0]?.writeId, null);
    await sleep(600);
    assert.equal(events.length, 1, "echo of the hub's own write must not produce a second disk-sourced broadcast");

    events.length = 0;
    daily.writeDaily(settings, "2026-09-03", "written by hub with id", undefined, "client-write-1");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.writeId, "client-write-1");
    await sleep(600);
    assert.equal(events.length, 1, "echo of a writeId'd hub write must not produce a second broadcast");

    events.length = 0;
    writeFileSync(join(root, "daily", "notes.md"), "not a daily date");
    await sleep(600);
    assert.equal(events.length, 0, "a non-daily-date filename must not produce a broadcast");

    events.length = 0;
    mkdirSync(join(root, "daily", "2026-08"), { recursive: true });
    writeFileSync(join(root, "daily", "2026-08", "2026-08-20.md"), "# archived day");
    await sleep(600);
    assert.equal(events.length, 1, "an external edit inside an archived month folder must broadcast");
    assert.equal(events[0]?.date, "2026-08-20");
    assert.equal(events[0]?.source, "disk");
    assert.equal(events[0]?.writeId, null);

    unsubscribe();
  });
});

describe("daily HTTP routes", () => {
  const box: Sandbox = makeSandbox("cch-daily-http-");
  let hub: RunningServer;

  interface HttpResult {
    status: number;
    json: unknown;
  }

  async function http(method: string, path: string, body?: unknown): Promise<HttpResult> {
    const res = await fetch(`${hub.base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text.length > 0 ? JSON.parse(text) : null };
  }

  before(async () => {
    hub = await startServer(box, { HUB_DELEGATION: "1" });
  });

  after(async () => {
    hub.child.kill();
  });

  it("reports the feature as unavailable before a root is linked", async () => {
    const res = await http("GET", "/delegation/daily");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { enabled: false, root: null, dir: null, today: (res.json as { today: string }).today, dates: [], running: null, templatePath: null });
  });

  it("rejects a malformed date on every daily route", async () => {
    assert.equal((await http("GET", "/delegation/daily/not-a-date")).status, 400);
    assert.equal((await http("PUT", "/delegation/daily/not-a-date", { content: "x" })).status, 400);
    assert.equal((await http("POST", "/delegation/daily/nope/generate", {})).status, 400);
  });

  it("refuses to generate while the feature is disabled", async () => {
    const put = await http("PUT", "/delegation/settings", { secondBrainRoot: box.brain });
    assert.equal(put.status, 200);
    const res = await http("POST", "/delegation/daily/2026-09-15/generate", {});
    assert.equal(res.status, 400);
  });

  it("lists the linked root once enabled and round-trips a diary through PUT/GET", async () => {
    const put = await http("PUT", "/delegation/settings", { features: { daily: true } });
    assert.equal(put.status, 200);
    assert.equal((put.json as { features: { daily: boolean } }).features.daily, true);

    const overview = await http("GET", "/delegation/daily");
    assert.equal((overview.json as { enabled: boolean }).enabled, true);
    assert.equal((overview.json as { root: string | null }).root, box.brain);
    assert.deepEqual((overview.json as { dates: string[] }).dates, []);

    const write = await http("PUT", "/delegation/daily/2026-09-15", { content: "# hi\n" });
    assert.equal(write.status, 200);

    const read = await http("GET", "/delegation/daily/2026-09-15");
    assert.equal(read.status, 200);
    assert.equal((read.json as { content: string }).content, "# hi\n");
    assert.equal((read.json as { exists: boolean }).exists, true);
  });

  it("rejects calendar-invalid dates with a real root linked, and creates no file", async () => {
    for (const date of ["2026-13-40", "9999-99-99"]) {
      const get = await http("GET", `/delegation/daily/${date}`);
      assert.equal(get.status, 400);
      assert.deepEqual(get.json, { error: "date must be a valid YYYY-MM-DD" });

      const put = await http("PUT", `/delegation/daily/${date}`, { content: "should not persist" });
      assert.equal(put.status, 400);
      assert.deepEqual(put.json, { error: "date must be a valid YYYY-MM-DD" });

      assert.equal(existsSync(join(box.brain, "daily", `${date}.md`)), false);
      assert.equal(existsSync(join(box.brain, "daily", `${date.slice(0, 7)}`, `${date}.md`)), false);
    }
  });

  it("returns 400 for a malformed sessions date query", async () => {
    assert.equal((await http("GET", "/delegation/daily/sessions?date=nope")).status, 400);
    const ok = await http("GET", "/delegation/daily/sessions?date=2026-09-15");
    assert.equal(ok.status, 200);
    assert.ok(Array.isArray(ok.json));
  });

  it("launches a headless run with the vault as cwd, and 409s a concurrent generate for the same date", async () => {
    const first = await http("POST", "/delegation/daily/2026-09-20/generate", { focus: "ship the daily tab" });
    assert.equal(first.status, 201);
    const taskId = (first.json as { taskId: string }).taskId;
    assert.ok(taskId);

    const second = await http("POST", "/delegation/daily/2026-09-20/generate", {});
    assert.equal(second.status, 409);
    assert.ok((second.json as { taskId: string }).taskId);

    const detail = await waitFor(async () => {
      const res = await http("GET", `/delegation/tasks/${taskId}`);
      const task = (res.json as { task: { status: string } }).task;
      return ["completed", "attention", "failed", "interrupted", "cancelled"].includes(task.status) ? res.json : null;
    }, 15000);
    assert.equal((detail as { task: { status: string; cwd: string } }).task.status, "completed");
    assert.equal((detail as { task: { status: string; cwd: string } }).task.cwd, box.brain);

    const capture = JSON.parse(readFileSync(box.claudeCapture, "utf8")) as { cwd: string; prompt: string };
    assert.equal(capture.cwd, box.brain);
    assert.match(capture.prompt, /ship the daily tab/);
    assert.doesNotMatch(capture.prompt, /\{\{/);

    const overview = await http("GET", "/delegation/daily");
    assert.equal((overview.json as { running: unknown }).running, null);
  });

  const YESTERDAY_FIXTURE =
    "---\ntype: daily\ncreated: 2026-09-13\n---\n\n# 2026-09-13\n\n## Focus\n" +
    "- [x] equatorial - task one\n  - note one\n- [ ] workai - task two\n\n## Meetings\n-\n";

  it("prepare returns yesterday's top-level tasks with carry-over blocks, headings and wikilinks", async () => {
    const put = await http("PUT", "/delegation/daily/2026-09-13", { content: YESTERDAY_FIXTURE });
    assert.equal(put.status, 200);

    const res = await http("GET", "/delegation/daily/2026-09-14/prepare");
    assert.equal(res.status, 200);
    const body = res.json as {
      date: string;
      yesterday: { date: string; closed: boolean; tasks: { line: number; checked: boolean; text: string; block: string }[] } | null;
      sessionsToday: unknown[];
      headings: { focus: string; meetings: string; sessions: string };
      wikilinks: boolean;
      templatePath: string | null;
    };
    assert.equal(body.date, "2026-09-14");
    assert.ok(body.yesterday);
    assert.equal(body.yesterday!.date, "2026-09-13");
    assert.equal(body.yesterday!.closed, false);
    assert.equal(body.yesterday!.tasks.length, 2);
    assert.equal(body.yesterday!.tasks[0]!.text, "equatorial - task one");
    assert.equal(body.yesterday!.tasks[0]!.block, "- [x] equatorial - task one\n  - note one");
    assert.equal(body.yesterday!.tasks[1]!.text, "workai - task two");
    assert.equal(body.yesterday!.tasks[1]!.block, "- [ ] workai - task two");
    assert.ok(Array.isArray(body.sessionsToday));
    assert.deepEqual(body.headings, { focus: "Focus", meetings: "Meetings", sessions: "Sessions" });
    assert.equal(body.wikilinks, false);
  });

  it("close-yesterday flips checkboxes on disk, stamps closed in frontmatter, and 400s on bad input", async () => {
    const closeBad = await http("POST", "/delegation/daily/not-a-date/close-yesterday", { yesterday: "2026-09-13", tasks: [] });
    assert.equal(closeBad.status, 400);

    const missingFile = await http("POST", "/delegation/daily/2026-09-14/close-yesterday", { yesterday: "2020-01-01", tasks: [] });
    assert.equal(missingFile.status, 400);

    const res = await http("POST", "/delegation/daily/2026-09-14/close-yesterday", {
      yesterday: "2026-09-13",
      tasks: [{ line: 10, checked: true }],
      summary: "ignored by design",
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { date: "2026-09-13", updatedAt: (res.json as { updatedAt: number }).updatedAt, closed: true });

    const onDisk = readFileSync(join(box.brain, "daily", "2026-09-13.md"), "utf8");
    assert.match(onDisk, /- \[x\] workai - task two/);
    assert.match(onDisk, /closed: 2026-09-14/);
    assert.doesNotMatch(onDisk, /ignored by design/);
  });

  it("flips the right task by content even when a frontmatter insert shifts every line below it", async () => {
    const settingsPut = await http("PUT", "/delegation/settings", { daily: { closedKey: "fechado" } });
    assert.equal(settingsPut.status, 200);
    assert.equal((settingsPut.json as { daily: { closedKey: string } }).daily.closedKey, "fechado");

    const write = await http("PUT", "/delegation/daily/2026-09-22", { content: REFERENCE_DIARY });
    assert.equal(write.status, 200);

    const prepare = await http("GET", "/delegation/daily/2026-09-23/prepare");
    assert.equal(prepare.status, 200);
    const yesterday = (prepare.json as { yesterday: { date: string; tasks: { line: number; text: string; checked: boolean }[] } }).yesterday!;
    assert.equal(yesterday.date, "2026-09-22");
    const distefano = yesterday.tasks.find((task) => task.text.includes("di-stefano"))!;
    assert.equal(distefano.checked, false);
    const alreadyDone = yesterday.tasks.find((task) => task.text.includes("Excluir apps EQTL"))!;
    assert.equal(alreadyDone.checked, true);

    const close = await http("POST", "/delegation/daily/2026-09-23/close-yesterday", {
      yesterday: "2026-09-22",
      tasks: [{ line: distefano.line, checked: true }],
    });
    assert.equal(close.status, 200);
    assert.equal((close.json as { closed: boolean }).closed, true);

    const onDisk = readFileSync(join(box.brain, "daily", "2026-09-22.md"), "utf8");
    assert.match(onDisk, /fechado: 2026-09-23/);
    assert.match(onDisk, /- \[x\] \[\[di-stefano\|Distefano\]\] - Evoluir auth da aplicação analisando Docs/);
    assert.match(onDisk, /- \[x\] \[\[equatorial\|Equatorial\]\] - Excluir apps EQTL Agiltec\/PAM - Portal de Agendamentos/);
    assert.match(onDisk, /- \[ \] Migração e limpeza de projetos/);

    const restore = await http("PUT", "/delegation/settings", { daily: { closedKey: "closed" } });
    assert.equal(restore.status, 200);
  });

  it("compose builds today's diary from the template, 409s when it exists, and overwrites on request", async () => {
    const first = await http("POST", "/delegation/daily/2026-09-21/compose", {
      briefing: "trail summary",
      focus: [{ project: "equatorial", text: "ship the daily tab" }],
      meetings: ["09:30 Today"],
    });
    assert.equal(first.status, 200);
    const firstContent = (first.json as { content: string }).content;
    assert.match(firstContent, /# 2026-09-21/);
    assert.match(firstContent, /> \*\*Briefing:\*\*/);
    assert.match(firstContent, /## Focus\n- \[ \] equatorial - ship the daily tab/);
    assert.match(firstContent, /## Meetings\n- 09:30 Today/);

    const conflict = await http("POST", "/delegation/daily/2026-09-21/compose", { focus: [], meetings: [] });
    assert.equal(conflict.status, 409);
    assert.equal((conflict.json as { error: string }).error, "diary exists");

    const overwritten = await http("POST", "/delegation/daily/2026-09-21/compose", {
      focus: [{ project: null, text: "replaced" }],
      meetings: [],
      overwrite: true,
    });
    assert.equal(overwritten.status, 200);
    assert.match((overwritten.json as { content: string }).content, /## Focus\n- \[ \] replaced/);
  });
});
