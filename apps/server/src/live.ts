import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import { getSession, listAgents } from "./db.js";
import { readTranscriptTailAsync, type TranscriptEntry } from "./transcript.js";
import type { AgentRecord, SessionRecord } from "./types.js";
import { summarizeAgent, type SessionLiveSummary } from "./live-summary.js";

export interface LiveAgent extends AgentRecord {
  transcript: TranscriptEntry[];
}

export interface SessionLive {
  session: SessionRecord;
  transcript: TranscriptEntry[];
  agents: LiveAgent[];
}

export function subagentTranscriptPath(
  sessionTranscript: string | null,
  sessionId: string,
  agentId: string,
): string | null {
  if (!sessionTranscript) return null;
  const base = join(dirname(sessionTranscript), sessionId, "subagents");
  const direct = join(base, `agent-${agentId}.jsonl`);
  if (existsSync(direct)) return direct;
  const workflows = join(base, "workflows");
  if (!existsSync(workflows)) return null;
  for (const entry of readdirSync(workflows, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(workflows, entry.name, `agent-${agentId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const projectDirName = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, "-");

export function guessTranscriptPath(home: string, cwd: string | null, sessionId: string): string | null {
  if (!cwd) return null;
  const candidate = join(home, ".claude", "projects", projectDirName(cwd), `${sessionId}.jsonl`);
  return existsSync(candidate) ? candidate : null;
}

export async function sessionLive(sessionId: string, limit = 40): Promise<SessionLive | null> {
  const session = getSession(sessionId);
  if (!session) return null;
  const transcriptPath = session.transcriptPath ?? guessTranscriptPath(config.homeDir, session.cwd, sessionId);
  const [transcript, agents] = await Promise.all([
    readTranscriptTailAsync(transcriptPath, limit),
    Promise.all(
      listAgents(sessionId).map(async (agent) => {
        const path = agent.transcriptPath ?? subagentTranscriptPath(transcriptPath, sessionId, agent.agentId);
        return { ...agent, transcriptPath: path, transcript: await readTranscriptTailAsync(path, 12) };
      }),
    ),
  ]);
  return { session: { ...session, transcriptPath }, transcript, agents };
}

export async function sessionLiveSummary(sessionId: string, limit = 40): Promise<SessionLiveSummary | null> {
  const live = await sessionLive(sessionId, limit);
  if (!live) return null;
  const agents = live.agents.map(summarizeAgent);
  return {
    session: live.session,
    transcript: live.transcript,
    agents,
    agentCounts: { total: agents.length, running: agents.filter((agent) => agent.status === "running").length },
  };
}

export async function subagentLive(sessionId: string, agentId: string): Promise<{ agent: LiveAgent } | "no-session" | "no-agent"> {
  const session = getSession(sessionId);
  if (!session) return "no-session";
  const agent = listAgents(sessionId).find((item) => item.agentId === agentId);
  if (!agent) return "no-agent";
  const sessionTranscript = session.transcriptPath ?? guessTranscriptPath(config.homeDir, session.cwd, sessionId);
  const path = agent.transcriptPath ?? subagentTranscriptPath(sessionTranscript, sessionId, agent.agentId);
  return { agent: { ...agent, transcriptPath: path, transcript: await readTranscriptTailAsync(path, 12) } };
}
