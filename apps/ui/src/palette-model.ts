export type PaletteKind = "session" | "workspace" | "task" | "command" | "view";

export interface PaletteItem {
  id: string;
  kind: PaletteKind;
  title: string;
  subtitle?: string;
  keywords?: string[];
  run: () => void;
}

export const PALETTE_RESULT_CAP = 50;
export const PALETTE_RECENTS_MAX = 8;
export const PALETTE_RECENTS_KEY = "hub.palette.recent";

export const KIND_LABEL: Record<PaletteKind, string> = {
  session: "Session",
  workspace: "Workspace",
  task: "Task",
  command: "Command",
  view: "Go to",
};

const SCORE_EXACT = 1000;
const SCORE_PREFIX = 800;
const SCORE_WORD_START = 600;
const SCORE_SUBSTRING = 400;
const SCORE_SUBSEQUENCE = 100;
const WEIGHT_TITLE = 1;
const WEIGHT_KEYWORD = 0.8;
const WEIGHT_SUBTITLE = 0.6;
const RECENT_BONUS = 40;

export const normalizeText = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();

const isWordBoundary = (text: string, index: number): boolean => {
  if (index === 0) return true;
  return !/[\p{L}\p{N}]/u.test(text.charAt(index - 1));
};

const wordStartIndex = (text: string, token: string): number => {
  let from = 0;
  while (from <= text.length - token.length) {
    const found = text.indexOf(token, from);
    if (found < 0) return -1;
    if (isWordBoundary(text, found)) return found;
    from = found + 1;
  }
  return -1;
};

const subsequenceScore = (text: string, token: string): number => {
  let position = 0;
  let score = SCORE_SUBSEQUENCE;
  let previous = -2;
  for (const char of token) {
    const found = text.indexOf(char, position);
    if (found < 0) return 0;
    if (found === previous + 1) score += 8;
    if (isWordBoundary(text, found)) score += 10;
    score -= Math.min(found - position, 6);
    previous = found;
    position = found + 1;
  }
  return Math.max(score - text.length * 0.2, 1);
};

export const matchScore = (text: string, token: string): number => {
  if (!token || !text) return 0;
  if (text === token) return SCORE_EXACT;
  if (text.startsWith(token)) return SCORE_PREFIX - Math.min(text.length - token.length, 50) * 0.5;
  const wordStart = wordStartIndex(text, token);
  if (wordStart >= 0) return SCORE_WORD_START - Math.min(wordStart, 60) * 0.5;
  const substring = text.indexOf(token);
  if (substring >= 0) return SCORE_SUBSTRING - Math.min(substring, 60) * 0.5;
  return subsequenceScore(text, token);
};

interface Prepared {
  item: PaletteItem;
  index: number;
  title: string;
  subtitle: string;
  keywords: string[];
}

const prepare = (item: PaletteItem, index: number): Prepared => ({
  item,
  index,
  title: normalizeText(item.title),
  subtitle: normalizeText(item.subtitle ?? ""),
  keywords: (item.keywords ?? []).map(normalizeText),
});

const tokenScore = (prepared: Prepared, token: string): number => {
  let best = matchScore(prepared.title, token) * WEIGHT_TITLE;
  const subtitle = matchScore(prepared.subtitle, token) * WEIGHT_SUBTITLE;
  if (subtitle > best) best = subtitle;
  for (const keyword of prepared.keywords) {
    const score = matchScore(keyword, token) * WEIGHT_KEYWORD;
    if (score > best) best = score;
  }
  return best;
};

const emptyQueryItems = (items: PaletteItem[], recentIds: string[], cap: number): PaletteItem[] => {
  const byId = new Map(items.map((item) => [item.id, item]));
  const picked = new Set<string>();
  const result: PaletteItem[] = [];
  for (const id of recentIds) {
    const item = byId.get(id);
    if (!item || picked.has(id)) continue;
    picked.add(id);
    result.push(item);
  }
  for (const item of items) {
    if (picked.has(item.id)) continue;
    if (item.kind !== "command" && item.kind !== "view") continue;
    picked.add(item.id);
    result.push(item);
  }
  return result.slice(0, cap);
};

export const rankItems = (items: PaletteItem[], query: string, recentIds: string[] = [], cap: number = PALETTE_RESULT_CAP): PaletteItem[] => {
  const tokens = normalizeText(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return emptyQueryItems(items, recentIds, cap);
  const recentRank = new Map(recentIds.map((id, position) => [id, position]));
  const scored: { prepared: Prepared; score: number }[] = [];
  items.forEach((item, index) => {
    const prepared = prepare(item, index);
    let total = 0;
    for (const token of tokens) {
      const score = tokenScore(prepared, token);
      if (score <= 0) return;
      total += score;
    }
    const recent = recentRank.get(item.id);
    if (recent !== undefined) total += Math.max(RECENT_BONUS - recent * 4, 0);
    scored.push({ prepared, score: total });
  });
  scored.sort((a, b) => b.score - a.score || a.prepared.index - b.prepared.index);
  return scored.slice(0, cap).map((entry) => entry.prepared.item);
};

export const pushRecent = (recentIds: string[], id: string, max: number = PALETTE_RECENTS_MAX): string[] =>
  [id, ...recentIds.filter((existing) => existing !== id)].slice(0, Math.max(max, 0));

export const loadRecents = (key: string = PALETTE_RECENTS_KEY): string[] => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string").slice(0, PALETTE_RECENTS_MAX);
  } catch {
    return [];
  }
};

export const saveRecents = (recentIds: string[], key: string = PALETTE_RECENTS_KEY): void => {
  try {
    localStorage.setItem(key, JSON.stringify(recentIds.slice(0, PALETTE_RECENTS_MAX)));
  } catch {
    return;
  }
};
