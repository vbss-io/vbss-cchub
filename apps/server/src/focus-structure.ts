import type { DelegationSettings } from "./delegation-types.js";
import {
  checkboxForStatus,
  docLine,
  firstFold,
  flattenTasks,
  focusRange,
  joinReason,
  normalizeText,
  scanDaily,
  stripInlineMarkup,
  taskBody,
  taskNeedle,
  type BoardCheckbox,
  type BoardProject,
  type BoardStatus,
  type BoardTask,
  type DocLine,
  type FocusScan,
  type ParsedDoc,
  type TextFold,
} from "./tasks-board.js";

export interface StructureData {
  projects: BoardProject[];
  tasks: BoardTask[];
}

export interface EngineLink {
  task: BoardTask;
  title: string | null;
}

export interface StructureDivergence {
  line: DocLine;
  task: BoardTask;
  checkbox: BoardCheckbox;
}

export interface StructureRename {
  line: DocLine;
  task: BoardTask;
  from: string;
  to: string;
}

export interface StructureSimilar {
  line: DocLine;
  index: number;
  task: BoardTask | null;
}

export interface StructureResult {
  changed: boolean;
  moved: string[];
  renamed: string[];
  renames: StructureRename[];
  merged: string[];
  merges: DocLine[];
  created: string[];
  divergent: StructureDivergence[];
  similar: StructureSimilar[];
  unclear: BoardTask[];
}

interface Node {
  line: DocLine;
  index: number;
  depth: number;
  lead: string;
  text: string;
  parent: Node | null;
  children: Node[];
  before: DocLine[];
  task: BoardTask | null;
  plain: string | null;
  oldTitle: string | null;
  renameTo: string | null;
  frozen: boolean;
}

interface Forest {
  roots: Node[];
  tail: DocLine[];
  nodes: Node[];
  start: number;
  end: number;
}

interface Attempt {
  lines: DocLine[];
  before: DocLine[];
  focus: DocLine[];
  linked: Set<DocLine>;
  texts: Map<DocLine, string>;
  placed: Map<string, Node>;
  touched: Set<string>;
  removed: Map<DocLine, DocLine>;
  result: StructureResult;
}

interface Body {
  core: string;
  suffix: string | null;
}

const LINE_RE = /^(\s*)[-*+]\s+\[([ xX-])\]\s?(.*)$/;
const LIST_RE = /^\s*(?:[-*+]|\d+[.)])(?:\s|$)/;
const SUFFIX_RE = /^(.*\S)\s+(_[^_\s](?:[^_]*[^_\s])?_)$/;
const MARKS: Record<BoardCheckbox, string> = { todo: " ", doing: "-", done: "x" };
const SYNCED: ReadonlySet<BoardStatus> = new Set<BoardStatus>(["todo", "doing", "done"]);
const OPEN: ReadonlySet<BoardStatus> = new Set<BoardStatus>(["todo", "doing", "blocked", "hold"]);
const MIN_TITLE = 12;
const MAX_ATTEMPTS = 6;
const DEFAULT_STEP = "  ";

export const noStructure = (): StructureResult => ({ changed: false, moved: [], renamed: [], renames: [], merged: [], merges: [], created: [], divergent: [], similar: [], unclear: [] });

function leadOf(text: string): string {
  return text.match(/^\s*/)?.[0] ?? "";
}

function depthOf(text: string): number {
  let spaces = 0;
  for (const ch of leadOf(text)) spaces += ch === "\t" ? 4 : 1;
  return Math.floor(spaces / 2);
}

function checkboxOf(text: string): BoardCheckbox | null {
  const mark = text.match(LINE_RE)?.[2];
  if (mark === undefined) return null;
  if (mark === "-") return "doing";
  return mark === " " ? "todo" : "done";
}

function restOf(text: string): string | null {
  return text.match(LINE_RE)?.[3] ?? null;
}

function withMark(text: string, checkbox: BoardCheckbox): string {
  return text.replace(/^(\s*[-*+]\s+\[)[ xX-](\])/, `$1${MARKS[checkbox]}$2`);
}

const isBlank = (line: DocLine): boolean => line.text.trim() === "";

const projectCheckbox = (task: BoardTask): BoardCheckbox | null => (SYNCED.has(task.status) ? checkboxForStatus(task.status) : null);

function entersDay(task: BoardTask, date: string): boolean {
  return OPEN.has(task.status) && (task.scheduled === date || task.subtasks.some((subtask) => entersDay(subtask, date)));
}

function newNode(line: DocLine, index: number, before: DocLine[]): Node {
  return { line, index, depth: depthOf(line.text), lead: leadOf(line.text), text: line.text, parent: null, children: [], before, task: null, plain: null, oldTitle: null, renameTo: null, frozen: false };
}

function buildForest(doc: ParsedDoc, start: number, end: number): Forest {
  const roots: Node[] = [];
  const nodes: Node[] = [];
  let stack: Node[] = [];
  let pending: DocLine[] = [];
  for (let index = start; index < end; index += 1) {
    const line = doc.lines[index] as DocLine;
    if (isBlank(line)) {
      pending.push(line);
      continue;
    }
    const node = newNode(line, index, pending);
    pending = [];
    nodes.push(node);
    const owner = stack[stack.length - 1];
    if (owner !== undefined && node.lead !== "" && !LIST_RE.test(line.text)) {
      node.parent = owner;
      owner.children.push(node);
      continue;
    }
    while (stack.length > 0 && (stack[stack.length - 1] as Node).depth >= node.depth) stack.pop();
    const parent = node.depth === 0 ? undefined : stack[stack.length - 1];
    if (parent === undefined) {
      if (node.depth > 0) node.frozen = true;
      roots.push(node);
      stack = [node];
      continue;
    }
    node.parent = parent;
    parent.children.push(node);
    stack.push(node);
  }
  return { roots, tail: pending, nodes, start, end };
}

function freeze(node: Node): void {
  node.frozen = true;
  for (const child of node.children) freeze(child);
}

function poolsOf(tasks: BoardTask[]): Map<string, BoardTask[]> {
  const pools = new Map<string, BoardTask[]>();
  for (const top of tasks) {
    if (top.repeat !== null && top.doneAt !== null) continue;
    for (const task of flattenTasks([top])) {
      if (task.repeat !== null) continue;
      pools.set(task.projectId, [...(pools.get(task.projectId) ?? []), task]);
    }
  }
  return pools;
}

function coreOf(text: string, separator: string): string {
  const cut = text.indexOf(` ${separator.trim()} `);
  return cut === -1 ? text : text.slice(0, cut);
}

function bodiesOf(settings: DelegationSettings, text: string): Body[] {
  const body = taskBody(text, settings.tasks);
  const split = body.match(SUFFIX_RE);
  return split === null ? [{ core: body, suffix: null }] : [{ core: body, suffix: null }, { core: split[1] as string, suffix: split[2] as string }];
}

function titleHits(settings: DelegationSettings, text: string, pool: BoardTask[]): BoardTask[] {
  return (
    firstFold((fold: TextFold) => {
      const needles = bodiesOf(settings, text)
        .map((body) => taskNeedle(body.core, settings.tasks, fold))
        .filter((needle) => needle !== "");
      if (needles.length === 0) return undefined;
      const exact = pool.filter((task) => needles.includes(fold(task.title)) || needles.includes(fold(joinReason(task.title, task.reason, settings.tasks.reasonSeparator))));
      return exact.length > 0 ? exact : undefined;
    }) ?? []
  );
}

function prefixHits(settings: DelegationSettings, text: string, pool: BoardTask[]): BoardTask[] {
  return (
    firstFold((fold: TextFold) => {
      const needle = taskNeedle(text, settings.tasks, fold);
      if (needle === "") return undefined;
      const longer = pool.filter((task) => {
        const title = fold(task.title);
        return title.length >= MIN_TITLE && needle.startsWith(`${title} `);
      });
      return longer.length > 0 ? longer : undefined;
    }) ?? []
  );
}

function coreHits(settings: DelegationSettings, text: string, pool: BoardTask[]): BoardTask[] {
  return (
    firstFold((fold: TextFold) => {
      const core = coreOf(taskNeedle(text, settings.tasks, fold), settings.tasks.reasonSeparator);
      if (core.length < MIN_TITLE) return undefined;
      const hits = pool.filter((task) => coreOf(fold(task.title), settings.tasks.reasonSeparator) === core);
      return hits.length > 0 ? hits : undefined;
    }) ?? []
  );
}

function descendantIds(task: BoardTask): Set<string> {
  return new Set(flattenTasks(task.subtasks).map((item) => item.id));
}

function anchorOf(node: Node): Node | null {
  for (let current = node.parent; current !== null; current = current.parent) if (current.task !== null) return current;
  return null;
}

function boxParent(node: Node): Node | null {
  for (let current = node.parent; current !== null; current = current.parent) if (checkboxOf(current.text) !== null) return current;
  return null;
}

function rootOf(node: Node): Node {
  let current = node;
  while (current.parent !== null) current = current.parent;
  return current;
}

function contains(outer: Node, inner: Node): boolean {
  for (let current: Node | null = inner; current !== null; current = current.parent) if (current === outer) return true;
  return false;
}

function renderTitle(settings: DelegationSettings, task: BoardTask): string {
  const body = joinReason(task.title, task.reason, settings.tasks.reasonSeparator);
  return task.prefix === null ? body : `${task.prefix}${settings.tasks.separator}${body}`;
}

function titlesOf(settings: DelegationSettings, task: BoardTask, extra: (string | null)[]): Set<string> {
  const titles = new Set([task.title, joinReason(task.title, task.reason, settings.tasks.reasonSeparator), renderTitle(settings, task)]);
  for (const title of extra) if (title !== null) titles.add(title);
  return titles;
}

function extendsTitle(settings: DelegationSettings, text: string, task: BoardTask): boolean {
  return (
    firstFold((fold: TextFold) => {
      const needle = taskNeedle(text, settings.tasks, fold);
      const titles = [fold(task.title), fold(joinReason(task.title, task.reason, settings.tasks.reasonSeparator))];
      if (needle === "" || titles.includes(needle)) return undefined;
      return titles.some((title) => title.startsWith(`${needle} `)) ? true : undefined;
    }) ?? false
  );
}

function plainOf(node: Node): string {
  return node.plain ?? restOf(node.text) ?? node.text.trim();
}

function isExact(settings: DelegationSettings, node: Node, task: BoardTask): boolean {
  const titles = titlesOf(settings, task, [node.oldTitle]);
  return bodiesOf(settings, plainOf(node)).some((body) => titles.has(body.core) || titles.has(stripInlineMarkup(body.core)));
}

function removalOf(settings: DelegationSettings, titles: ReadonlySet<string>, gone: string, kept: string): { suffix: string | null } | null {
  for (const removed of bodiesOf(settings, gone)) {
    if (!titles.has(removed.core)) continue;
    for (const survivor of bodiesOf(settings, kept)) {
      if (survivor.core !== removed.core && stripInlineMarkup(survivor.core) !== removed.core) continue;
      if (removed.suffix === null || removed.suffix === survivor.suffix) return { suffix: null };
      if (survivor.suffix === null) return { suffix: removed.suffix };
    }
  }
  return null;
}

function renameOf(settings: DelegationSettings, node: Node, task: BoardTask): string | null {
  if (node.renameTo !== null) return node.renameTo;
  const plain = plainOf(node);
  const title = renderTitle(settings, task);
  if (node.oldTitle !== null && node.oldTitle !== task.title && plain.includes(node.oldTitle)) return plain.replace(node.oldTitle, task.title);
  return extendsTitle(settings, plain, task) ? title : null;
}

interface Placer {
  settings: DelegationSettings;
  projects: Map<string, BoardProject>;
  step: string;
  forest: Forest;
  cursors: Map<Node, Node>;
  attempt: Attempt;
}

function labelOf(placer: Placer, task: BoardTask): string {
  const project = placer.projects.get(task.projectId);
  if (project === undefined) return task.projectId;
  return placer.settings.daily.wikilinks ? `[[${project.name}|${project.title}]]` : project.title;
}

function childLead(placer: Placer, parent: Node, except: Node | null): string {
  const sample = parent.children.find((child) => child !== except && child.lead.length > parent.lead.length && child.lead.startsWith(parent.lead));
  if (sample !== undefined) return sample.lead;
  return `${parent.lead}${parent.lead.includes("\t") ? "\t" : placer.step}`;
}

function reindent(node: Node, lead: string): void {
  const old = node.lead;
  node.text = `${lead}${node.text.slice(old.length)}`;
  node.lead = lead;
  for (const child of node.children) {
    const own = child.lead.startsWith(old) ? child.lead.slice(old.length) : DEFAULT_STEP;
    reindent(child, `${lead}${own || DEFAULT_STEP}`);
  }
}

function detach(placer: Placer, node: Node): void {
  const siblings = node.parent === null ? placer.forest.roots : node.parent.children;
  const at = siblings.indexOf(node);
  if (at === -1) return;
  siblings.splice(at, 1);
  if (node.parent === null && node.before.length > 0) {
    const next = siblings[at];
    if (next !== undefined && next.before.length === 0) next.before = node.before;
    else if (next === undefined) placer.forest.tail = [...node.before, ...placer.forest.tail];
  }
  node.before = [];
  node.parent = null;
}

function orderIndex(siblings: Node[], node: Node): number {
  const task = node.task;
  if (task === null) return siblings.length;
  const later = siblings.findIndex((other) => other !== node && other.task !== null && other.task.projectId === task.projectId && other.task.line > task.line);
  return later === -1 ? siblings.length : later;
}

function attachUnder(placer: Placer, node: Node, parent: Node): void {
  const lead = childLead(placer, parent, node);
  const top = node.parent === null;
  detach(placer, node);
  const mark = node.text.match(LINE_RE)?.[2] ?? " ";
  if (top && node.plain !== null) node.text = `${node.lead}- [${mark}] ${node.plain}`;
  node.plain = null;
  reindent(node, lead);
  node.parent = parent;
  parent.children.splice(orderIndex(parent.children, node), 0, node);
}

function attachTop(placer: Placer, node: Node, task: BoardTask): void {
  const root = rootOf(node);
  const cursor = placer.cursors.get(root) ?? root;
  const mark = node.text.match(LINE_RE)?.[2] ?? " ";
  const plain = plainOf(node);
  detach(placer, node);
  reindent(node, "");
  node.text = `- [${mark}] ${labelOf(placer, task)} - ${plain}`;
  node.plain = plain;
  const roots = placer.forest.roots;
  const at = roots.indexOf(cursor);
  const position = at === -1 ? roots.length : at + 1;
  const neighbour = root.task?.projectId ?? null;
  node.before = neighbour === task.projectId ? [] : [docLine("")];
  roots.splice(position, 0, node);
  placer.cursors.set(root, node);
}

function createUnder(placer: Placer, parent: Node, task: BoardTask): Node {
  const lead = childLead(placer, parent, null);
  const text = `${lead}- [${MARKS[checkboxForStatus(task.status)]}] ${task.title}`;
  const line = docLine(text);
  const node: Node = { ...newNode(line, -1, []), parent, task };
  parent.children.splice(orderIndex(parent.children, node), 0, node);
  placer.attempt.texts.set(line, text);
  placer.attempt.linked.add(line);
  placer.attempt.result.created.push(task.id);
  placer.attempt.touched.add(task.id);
  return node;
}

function mergeInto(placer: Placer, other: Node, survivor: Node): void {
  for (const child of [...other.children]) {
    detach(placer, child);
    reindent(child, childLead(placer, survivor, child));
    child.parent = survivor;
    survivor.children.push(child);
  }
  detach(placer, other);
  placer.attempt.removed.set(other.line, survivor.line);
}

function carrySuffix(node: Node, suffix: string): void {
  const join = (text: string): string => (/\s$/.test(text) ? `${text}${suffix}` : `${text} ${suffix}`);
  node.text = join(node.text);
  if (node.plain !== null) node.plain = join(node.plain);
}

function render(forest: Forest): DocLine[] {
  const out: DocLine[] = [];
  const emit = (node: Node): void => {
    out.push(...node.before, node.line);
    for (const child of node.children) emit(child);
  };
  for (const root of forest.roots) emit(root);
  out.push(...forest.tail);
  return out;
}

function stepOf(forest: Forest): string {
  for (const node of forest.nodes) {
    const parent = node.parent;
    if (parent !== null && LIST_RE.test(node.text) && node.lead.startsWith(parent.lead) && node.lead.length > parent.lead.length) return node.lead.slice(parent.lead.length);
  }
  return DEFAULT_STEP;
}

interface Linker {
  settings: DelegationSettings;
  date: string;
  unclear: Map<string, BoardTask>;
  similar: StructureSimilar[];
}

function link(linker: Linker, forest: Forest, scan: FocusScan, data: StructureData, known: ReadonlyMap<DocLine, EngineLink>, frozen: ReadonlySet<string>): void {
  const { settings, date, unclear } = linker;
  const parents = parentsOf(data.tasks);
  const nodeAtLine = new Map(forest.nodes.map((node) => [node.index, node]));
  for (const entry of scan.entries) {
    const head = nodeAtLine.get(entry.line);
    if (head === undefined) continue;
    head.plain = entry.text;
    if (entry.recurring) {
      freeze(head);
      continue;
    }
    head.task = entry.match.task;
    for (const child of entry.children) {
      const node = nodeAtLine.get(child.line);
      if (node !== undefined && child.task !== null) node.task = child.task;
    }
  }
  for (const node of forest.nodes) {
    if (node.frozen) continue;
    const engine = known.get(node.line);
    if (node.task === null && engine !== undefined) node.task = engine.task;
    if (engine !== undefined && node.task?.id === engine.task.id) node.oldTitle = engine.title;
  }
  const pools = poolsOf(data.tasks);
  for (const node of forest.nodes) {
    const old = node.oldTitle;
    const task = node.task;
    if (old === null || task === null) continue;
    const wanted = normalizeText(old);
    if ((pools.get(task.projectId) ?? []).some((other) => normalizeText(other.title) === wanted)) node.oldTitle = null;
  }
  const claimed = new Set(forest.nodes.flatMap((node) => (node.task === null ? [] : [node.task.id])));
  const labels = new Map(scan.entries.map((entry) => [entry.line, entry.projectId]));
  const rootProject = new Map<Node, string | null>();
  for (const [index, projectId] of labels) {
    const node = nodeAtLine.get(index);
    if (node !== undefined) rootProject.set(node, projectId);
  }
  for (const node of forest.nodes) {
    if (node.frozen || node.task !== null || node.parent === null) continue;
    const text = restOf(node.text);
    if (text === null || text.trim() === "") continue;
    const anchor = anchorOf(node);
    const projectId = anchor?.task?.projectId ?? rootProject.get(rootOf(node)) ?? null;
    if (projectId === null) continue;
    const pool = pools.get(projectId) ?? [];
    const inside = anchor?.task ? descendantIds(anchor.task) : null;
    const related = (task: BoardTask): boolean => {
      if (inside?.has(task.id) === true) return true;
      for (let current: BoardTask | null = task; current !== null; current = parents.get(current.id) ?? null) if (current.scheduled === date || entersDay(current, date)) return true;
      return false;
    };
    let hits = titleHits(settings, text, pool).filter(related);
    if (hits.length > 1 && inside !== null) {
      const narrowed = hits.filter((task) => inside.has(task.id));
      if (narrowed.length > 0) hits = narrowed;
    }
    if (hits.length > 1) {
      const dated = hits.filter((task) => task.scheduled === date);
      if (dated.length > 0) hits = dated;
    }
    if (hits.length === 1) {
      node.task = hits[0] as BoardTask;
      continue;
    }
    if (hits.length > 1) {
      for (const task of hits) if (entersDay(task, date)) unclear.set(task.id, task);
      continue;
    }
    const renamed = inside === null ? [] : coreHits(settings, text, pool.filter((task) => inside.has(task.id) && !claimed.has(task.id)));
    if (renamed.length === 1) {
      const task = renamed[0] as BoardTask;
      node.task = task;
      node.renameTo = renderTitle(settings, task);
      claimed.add(task.id);
      continue;
    }
    const loose = prefixHits(settings, text, pool).filter(related);
    if (loose.length > 0) linker.similar.push({ line: node.line, index: node.index, task: loose.length === 1 ? (loose[0] as BoardTask) : null });
  }
  for (const node of forest.nodes) if (node.task !== null && (node.task.repeat !== null || frozen.has(node.task.id))) node.task = null;
}

function parentsOf(tasks: BoardTask[]): Map<string, BoardTask | null> {
  const map = new Map<string, BoardTask | null>();
  const visit = (task: BoardTask, parent: BoardTask | null): void => {
    map.set(task.id, parent);
    for (const subtask of task.subtasks) visit(subtask, task);
  };
  for (const task of tasks) visit(task, null);
  return map;
}

function attempt(settings: DelegationSettings, date: string, doc: ParsedDoc, data: StructureData, known: ReadonlyMap<DocLine, EngineLink>, frozen: ReadonlySet<string>): Attempt | null {
  const texts = doc.lines.map((line) => line.text);
  const range = focusRange(texts, settings);
  if (range === null) return null;
  const forest = buildForest(doc, range.heading + 1, range.end);
  const scan = scanDaily(settings, date, texts.join("\n"), data.projects, data.tasks);
  const linker: Linker = { settings, date, unclear: new Map<string, BoardTask>(), similar: [] };
  link(linker, forest, scan, data, known, frozen);
  const result = noStructure();
  result.unclear = [...linker.unclear.values()];
  result.similar = linker.similar;
  const before = doc.lines.slice(forest.start, forest.end);
  const linked = new Set(forest.nodes.flatMap((node) => (node.task === null ? [] : [node.line])));
  const state: Attempt = { lines: [], before, focus: [], linked, texts: new Map(), placed: new Map(), touched: new Set(), removed: new Map(), result };
  const placer: Placer = { settings, projects: new Map(data.projects.map((project) => [project.id, project])), step: stepOf(forest), forest, cursors: new Map(), attempt: state };
  const groups = new Map<string, Node[]>();
  for (const node of forest.nodes) if (!node.frozen && node.task !== null) groups.set(node.task.id, [...(groups.get(node.task.id) ?? []), node]);
  const parents = parentsOf(data.tasks);
  const original = new Map(forest.nodes.map((node) => [node, node.text]));
  for (const task of flattenTasks(data.tasks)) {
    const nodes = groups.get(task.id);
    if (nodes === undefined) continue;
    const chain: BoardTask[] = [];
    let anchor: Node | null = null;
    for (let parent = parents.get(task.id) ?? null; parent !== null; parent = parents.get(parent.id) ?? null) {
      const found = state.placed.get(parent.id);
      if (found !== undefined) {
        anchor = found;
        break;
      }
      chain.unshift(parent);
    }
    const atPlace = (node: Node): boolean => (anchor === null ? node.parent === null : chain.length === 0 && boxParent(node) === anchor);
    const exact = (node: Node): boolean => isExact(settings, node, task);
    const survivor = nodes.find((node) => atPlace(node) && exact(node)) ?? nodes.find(atPlace) ?? nodes.find(exact) ?? (nodes[0] as Node);
    state.placed.set(task.id, survivor);
    if (anchor !== null && contains(survivor, anchor)) continue;
    const wanted = projectCheckbox(task);
    for (const other of nodes) {
      if (other === survivor || contains(other, survivor) || contains(survivor, other) || (anchor !== null && contains(other, anchor))) continue;
      const removal = removalOf(settings, titlesOf(settings, task, [other.oldTitle, survivor.oldTitle]), plainOf(other), plainOf(survivor));
      if (removal === null) {
        result.similar.push({ line: other.line, index: other.index, task });
        if (!exact(survivor)) result.similar.push({ line: survivor.line, index: survivor.index, task });
        continue;
      }
      const theirs = checkboxOf(other.text);
      const mine = checkboxOf(survivor.text);
      if (theirs !== null && mine !== null && theirs !== mine && wanted !== null) {
        survivor.text = withMark(survivor.text, wanted);
        const odd = theirs !== wanted ? theirs : mine;
        result.divergent.push({ line: survivor.line, task, checkbox: odd });
      }
      if (removal.suffix !== null) carrySuffix(survivor, removal.suffix);
      mergeInto(placer, other, survivor);
      result.merged.push(task.id);
      if (!result.merges.includes(survivor.line)) result.merges.push(survivor.line);
      state.touched.add(task.id);
    }
    if (!atPlace(survivor)) {
      if (anchor === null) attachTop(placer, survivor, task);
      else {
        let target = anchor;
        for (const parent of chain) {
          target = createUnder(placer, target, parent);
          state.placed.set(parent.id, target);
        }
        attachUnder(placer, survivor, target);
      }
      result.moved.push(task.id);
      state.touched.add(task.id);
    }
    const renamed = renameOf(settings, survivor, task);
    if (renamed !== null) {
      const rest = restOf(survivor.text);
      if (rest !== null) {
        const from = plainOf(survivor).trim();
        const head = survivor.text.slice(0, survivor.text.length - rest.length);
        const label = survivor.parent === null && survivor.plain !== null && rest.endsWith(survivor.plain) ? rest.slice(0, rest.length - survivor.plain.length) : "";
        survivor.text = `${head}${label}${renamed}`;
        survivor.plain = survivor.parent === null ? renamed : null;
        result.renamed.push(task.id);
        result.renames.push({ line: survivor.line, task, from, to: renamed.trim() });
        state.touched.add(task.id);
      }
    }
    if (state.touched.has(task.id) && wanted !== null && !result.divergent.some((item) => item.task.id === task.id)) {
      const mine = checkboxOf(survivor.text);
      if (mine !== null && mine !== wanted) result.divergent.push({ line: survivor.line, task, checkbox: mine });
    }
  }
  for (const node of forest.nodes) if (node.text !== original.get(node)) state.texts.set(node.line, node.text);
  for (const node of [...state.placed.values()]) if (!original.has(node)) state.texts.set(node.line, node.text);
  state.focus = render(forest);
  state.lines = [...doc.lines.slice(0, forest.start), ...state.focus, ...doc.lines.slice(forest.end)];
  return state;
}

function unlinkedLines(lines: DocLine[], texts: ReadonlyMap<DocLine, string>, linked: ReadonlySet<DocLine>): string[] {
  return lines
    .flatMap((line) => {
      const text = (texts.get(line) ?? line.text).trim();
      return text === "" || linked.has(line) ? [] : [text];
    })
    .sort();
}

function losesLines(state: Attempt): boolean {
  const kept = new Set(state.focus);
  return state.before.some((line) => {
    if (kept.has(line) || isBlank(line)) return false;
    const survivor = state.removed.get(line);
    return survivor === undefined || !kept.has(survivor);
  });
}

function failedTasks(settings: DelegationSettings, date: string, data: StructureData, state: Attempt): Set<string> {
  const texts = state.lines.map((line) => state.texts.get(line) ?? line.text);
  const scan = scanDaily(settings, date, texts.join("\n"), data.projects, data.tasks);
  const linked = new Map<number, string>();
  for (const entry of scan.entries) {
    if (entry.match.task !== null) linked.set(entry.line, entry.match.task.id);
    for (const child of entry.children) if (child.task !== null) linked.set(child.line, child.task.id);
  }
  const failed = new Set<string>();
  for (const id of state.touched) {
    const node = state.placed.get(id);
    const index = node === undefined ? -1 : state.lines.indexOf(node.line);
    if (index === -1 || linked.get(index) !== id) failed.add(id);
  }
  const kept = unlinkedLines(state.before, new Map(), state.linked).join("\n");
  if (kept !== unlinkedLines(state.focus, state.texts, state.linked).join("\n") || losesLines(state)) for (const id of state.touched) failed.add(id);
  return failed;
}

export function restructureFocus(
  settings: DelegationSettings,
  date: string,
  doc: ParsedDoc,
  data: StructureData,
  known: ReadonlyMap<DocLine, EngineLink> = new Map(),
): StructureResult {
  const frozen = new Set<string>();
  const unplaced = new Map<string, BoardTask>();
  for (let round = 0; round < MAX_ATTEMPTS; round += 1) {
    const state = attempt(settings, date, doc, data, known, frozen);
    if (state === null) return noStructure();
    const failed = failedTasks(settings, date, data, state);
    if (failed.size === 0) {
      const result = state.result;
      for (const task of unplaced.values()) if (entersDay(task, date) && !result.unclear.some((item) => item.id === task.id)) result.unclear.push(task);
      if (state.touched.size === 0) return result;
      for (const [line, text] of state.texts) line.text = text;
      doc.lines.splice(0, doc.lines.length, ...state.lines);
      result.changed = true;
      return result;
    }
    for (const id of failed) {
      frozen.add(id);
      const node = state.placed.get(id);
      if (node?.task) unplaced.set(id, node.task);
    }
  }
  return noStructure();
}
