import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import { getSession, listAgents } from "./db.js";
import { readTranscriptTail, type TranscriptEntry } from "./transcript.js";
import type { AgentRecord, SessionRecord } from "./types.js";

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
  const candidate = join(dirname(sessionTranscript), sessionId, "subagents", `agent-${agentId}.jsonl`);
  return existsSync(candidate) ? candidate : null;
}

const projectDirName = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, "-");

export function guessTranscriptPath(home: string, cwd: string | null, sessionId: string): string | null {
  if (!cwd) return null;
  const candidate = join(home, ".claude", "projects", projectDirName(cwd), `${sessionId}.jsonl`);
  return existsSync(candidate) ? candidate : null;
}

export function sessionLive(sessionId: string, limit = 40): SessionLive | null {
  const session = getSession(sessionId);
  if (!session) return null;
  const transcriptPath = session.transcriptPath ?? guessTranscriptPath(config.homeDir, session.cwd, sessionId);
  const agents = listAgents(sessionId).map((agent) => {
    const path = agent.transcriptPath ?? subagentTranscriptPath(transcriptPath, sessionId, agent.agentId);
    return { ...agent, transcriptPath: path, transcript: readTranscriptTail(path, 12) };
  });
  return {
    session: { ...session, transcriptPath },
    transcript: readTranscriptTail(transcriptPath, limit),
    agents,
  };
}
