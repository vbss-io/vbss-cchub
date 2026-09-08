import type { ShareRecord } from "./delegation";

const TRUST_CLAUSE: Record<ShareRecord["trust"], string> = {
  low: "read-only (answers and plans only, nothing is edited)",
  medium: "edits (files in the workspace, no shell)",
  high: "edits + shell (edits and runs safe commands)",
  total: "total (no blocks)",
};

export const shareAboutUrl = (link: string): string => {
  const [base, query] = link.split("?");
  return query ? `${base}/about?${query}` : `${base}/about`;
};

export function sharePrompt(share: ShareRecord, link: string): string {
  return [
    `I'm sharing a CC Hub link so you can help me. Link: ${link}`,
    `GET ${shareAboutUrl(link)} first: it tells you what this share allows, the endpoints and the rules; follow it.`,
    `Trust is ${TRUST_CLAUSE[share.trust]}.`,
    `Answers come from the owner's Claude, which has the "${share.workspace}" workspace open and sees every request.`,
    "Task: ",
  ].join("\n");
}
