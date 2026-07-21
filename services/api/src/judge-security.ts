/**
 * Security boundary for arbitration inputs.
 *
 * Evidence, task text, and submitted artifacts are untrusted data. They are
 * never instructions for the judge, and they are bounded and scrubbed before
 * they reach an LLM adapter or the deterministic policy.
 */

export const MAX_JUDGE_TEXT_CHARS = 20_000;
const MAX_JUDGE_LINES = 128;
const MAX_JUDGE_LINE_CHARS = 2_000;

export interface JudgeSecurityReport {
  text: string;
  redacted: boolean;
  truncated: boolean;
  suspicious: boolean;
  blockedInstructions: number;
  reasons: string[];
}

type SecurityRule = readonly [RegExp, string];

const SECRET_RULES: SecurityRule[] = [
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, 'private_key'],
  [/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,})\b/g, 'openai_api_key'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, 'aws_access_key'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, 'jwt'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'bearer_token'],
  [/\b(?:api[_ -]?key|secret|token|password|private[_ -]?key)\s*[:=]\s*["']?[^\s"',;]{8,}/gi, 'credential_assignment']
];

const INSTRUCTION_RULES: SecurityRule[] = [
  [/\b(?:ignore|disregard|forget|override)\b.{0,80}\b(?:previous|prior|above|all|any|the)\b.{0,40}\b(?:instruction|message|rule|policy)s?\b/gi, 'instruction_override'],
  [/\b(?:system|developer|assistant)\s+(?:prompt|message|instruction)s?\b/gi, 'role_impersonation'],
  [/\b(?:reveal|show|print|dump|exfiltrat\w*|leak)\b.{0,80}\b(?:secret|api[ _-]?key|token|password|private[ _-]?key|prompt)\b/gi, 'secret_exfiltration'],
  [/\b(?:change|approve|override|set|force)\b.{0,80}\b(?:verdict|criteria|trust\s+score|collateral|slash|settlement)\b/gi, 'settlement_manipulation'],
  [/<\s*(?:system|developer|assistant)\b/gi, 'role_tag'],
  [/\b(?:call|use|invoke|execute)\s+(?:a\s+)?tool\b/gi, 'tool_request'],
  [/\b(?:send|post|upload|fetch)\b.{0,50}\b(?:https?:\/\/|webhook|email|url)\b/gi, 'external_action']
];

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function clipLines(value: string): { text: string; truncated: boolean } {
  const lines = value.split(/\r?\n/);
  let truncated = lines.length > MAX_JUDGE_LINES;
  const bounded = lines.slice(0, MAX_JUDGE_LINES).map((line) => {
    if (line.length <= MAX_JUDGE_LINE_CHARS) return line;
    truncated = true;
    return `${line.slice(0, MAX_JUDGE_LINE_CHARS)} …[line truncated]`;
  });
  let text = bounded.join('\n');
  if (text.length > MAX_JUDGE_TEXT_CHARS) {
    truncated = true;
    text = `${text.slice(0, MAX_JUDGE_TEXT_CHARS)}\n…[evidence truncated]`;
  }
  return { text, truncated };
}

/** Sanitize one untrusted field while preserving enough text for auditability. */
export function sanitizeJudgeText(value: unknown, maxChars = MAX_JUDGE_TEXT_CHARS): JudgeSecurityReport {
  const original = String(value ?? '').replace(CONTROL_CHARACTERS, '');
  // Bound before regex inspection as well as before model transport. This
  // keeps a hostile artifact from turning the sanitizer into a CPU sink.
  const source = original.slice(0, Math.max(0, maxChars));
  let text = source;
  let redacted = false;
  const reasons: string[] = [];

  for (const [pattern, reason] of SECRET_RULES) {
    pattern.lastIndex = 0;
    if (!pattern.test(text)) continue;
    pattern.lastIndex = 0;
    text = text.replace(pattern, '[REDACTED_SECRET]');
    redacted = true;
    reasons.push(reason);
  }

  const matches = INSTRUCTION_RULES.flatMap(([pattern, reason]) => {
    pattern.lastIndex = 0;
    const found = text.match(pattern);
    return found?.length ? Array.from({ length: found.length }, () => reason) : [];
  });
  const clipped = clipLines(text);
  if (original.length > maxChars) clipped.truncated = true;
  if (clipped.truncated) reasons.push('bounded_input');
  return {
    text: clipped.text,
    redacted,
    truncated: clipped.truncated,
    suspicious: matches.length > 0,
    blockedInstructions: matches.length,
    reasons: unique([...reasons, ...matches])
  };
}

/** Merge findings from task context and agent/creator evidence without exposing raw text. */
export function mergeJudgeSecurityReports(...reports: JudgeSecurityReport[]): Omit<JudgeSecurityReport, 'text'> {
  return {
    redacted: reports.some((report) => report.redacted),
    truncated: reports.some((report) => report.truncated),
    suspicious: reports.some((report) => report.suspicious),
    blockedInstructions: reports.reduce((sum, report) => sum + report.blockedInstructions, 0),
    reasons: unique(reports.flatMap((report) => report.reasons))
  };
}

/**
 * Sanitize a complete evidence packet. The returned packet is the only version
 * that an arbitrator should inspect; the original remains in the dispute store
 * for authorized audit access and is never sent to the LLM.
 */
export function sanitizeArbitrationEvidence(value: string): JudgeSecurityReport {
  return sanitizeJudgeText(value, MAX_JUDGE_TEXT_CHARS);
}
