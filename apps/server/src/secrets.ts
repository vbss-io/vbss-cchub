const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;
const NOT_SECRET_NAME = /(URL|PATH|DIR|SOCK|FILE|NAME|SCOPE|LABEL|PORT|TARGET|MODE|SHELL|REGION|TYPE|PROMPTS|SDK|PROJECT_ID)$/i;
const MIN_LENGTH = 12;
const REDACTED = "[redacted]";

let cached: string[] | null = null;

export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const values = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < MIN_LENGTH) continue;
    if (!SECRET_NAME.test(key) || NOT_SECRET_NAME.test(key)) continue;
    values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

function known(): string[] {
  if (!cached) cached = secretValues();
  return cached;
}

export function resetSecretCache(): void {
  cached = null;
}

export function redactSecrets(text: string): string {
  let out = text;
  for (const value of known()) if (out.includes(value)) out = out.split(value).join(REDACTED);
  return out;
}

export function redactBuffer(data: Buffer): Buffer {
  for (const value of known()) if (data.includes(value)) return Buffer.from(redactSecrets(data.toString("utf8")), "utf8");
  return data;
}
