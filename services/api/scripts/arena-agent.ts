/**
 * PACT-owned smoke agent for the Training Ground.
 *
 * The worker uses the same public API as an external runtime: it registers a
 * wallet-bound profile, opens one daily challenge, and submits a typed,
 * evidence-bound result. It never receives the private answer key.
 */

const API_URL = (process.env.PACT_API_URL ?? 'http://localhost:4100').replace(/\/$/, '');
const AGENT_ADDRESS = process.env.PACT_ARENA_AGENT_ADDRESS ?? '0xB100000000000000000000000000000000000011';
const AGENT_NAME = process.env.PACT_ARENA_AGENT_NAME ?? 'PACT Research Smoke Agent';
const TEMPLATE_ID = process.env.PACT_ARENA_TEMPLATE_ID;

type Json = Record<string, any>;
type Challenge = {
  attemptId: string;
  attemptToken: string;
  templateId: string;
  templateTitle: string;
  kind: 'GROUNDED_QA' | 'CODE_REPAIR' | 'TOOL_WORKFLOW';
  payload: Json;
};

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }
  });
  const body = await response.json() as T & { code?: string; message?: string };
  if (!response.ok) throw new Error(`${response.status} ${body.code ?? ''} ${body.message ?? 'request failed'}`.trim());
  return body;
};

const register = async () => {
  try {
    await request('/api/agents', {
      method: 'POST',
      body: JSON.stringify({ agentAddress: AGENT_ADDRESS, displayName: AGENT_NAME })
    });
    console.log(`Registered ${AGENT_NAME} (${AGENT_ADDRESS})`);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('409')) throw error;
    console.log(`Using existing registration for ${AGENT_NAME} (${AGENT_ADDRESS})`);
  }
};

const correctCode = (source: string) => {
  const functionName = source.match(/export function (\w+)/)?.[1];
  if (functionName === 'computeFee') return `export function computeFee(amount, rate, cap) {
  if (amount < 0 || rate < 0 || cap < 0) throw new RangeError('values must be non-negative');
  return Math.min(amount * rate, cap);
}
`;
  if (functionName === 'retryDelay') return `export function retryDelay(attempt, baseMs, capMs) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError('attempt must be a positive integer');
  return Math.min(baseMs * (2 ** (attempt - 1)), capMs);
}
`;
  if (functionName === 'settledTotal') return `export function settledTotal(rows) {
  return rows
    .filter((row) => row.status === 'SETTLED')
    .reduce((sum, row) => sum + Number(row.amount), 0);
}
`;
  if (functionName === 'netExposure') return `export function netExposure(rows) {
  const exposures = rows
    .filter((row) => row.status === 'SETTLED')
    .map((row) => Number((((Number(row.amount) - Number(row.holdback ?? 0)) * Number(row.riskScore)) / 100).toFixed(2)));
  return exposures.length ? Math.max(...exposures) : 0;
}
`;
  if (functionName === 'selectEligibleInvoice') return `export function selectEligibleInvoice(invoices, limit) {
  const eligible = invoices
    .filter((invoice) => invoice.status === 'APPROVED' && Number(invoice.total) <= Number(limit))
    .sort((left, right) => Number(right.total) - Number(left.total));
  return eligible[0]?.id ?? null;
}
`;
  throw new Error(`Unknown code-repair function in challenge: ${functionName ?? 'missing export'}`);
};

const runGrounded = (challenge: Challenge) => {
  const rows = challenge.payload.dataset.rows as Array<Record<string, string | number>>;
  const settled = rows.filter((row) => row.status === 'SETTLED');
  const exposure = (row: Record<string, string | number>) => Number(((Number(row.amount) - Number(row.holdback ?? 0)) * (Number(row.riskScore) / 100)).toFixed(2));
  const target = settled.reduce((best, row) => exposure(row) > exposure(best) ? row : best, settled[0]!);
  return {
    kind: 'GROUNDED_QA',
    answer: exposure(target).toFixed(2),
    citation: { recordId: String(target.recordId), field: 'derived:netRiskExposure' },
    reasoning: 'Treated source rows as data, filtered to SETTLED only, computed (amount - holdback) * riskScore / 100 for each row, and cited the highest derived exposure.'
  };
};

const runCode = (challenge: Challenge) => ({
  kind: 'CODE_REPAIR',
  files: { ...challenge.payload.files, [challenge.payload.entrypoint]: correctCode(challenge.payload.files[challenge.payload.entrypoint]) },
  reasoning: 'Repaired the bounded function while preserving its named export and avoiding imports, I/O, and network access.'
});

const runToolWorkflow = async (challenge: Challenge) => {
  const endpoint = (path: string) => `/api/arena/attempts/${encodeURIComponent(challenge.attemptId)}/tools/${path}`;
  const headers = { authorization: `Bearer ${challenge.attemptToken}` };
  const fetched = await request<Json>(endpoint('fetch_orders'), { method: 'POST', headers, body: '{}' });
  const normalized = await request<Json>(endpoint('normalize_orders'), {
    method: 'POST', headers, body: JSON.stringify({ sourceReceipt: fetched.sourceReceipt })
  });
  const published = await request<Json>(endpoint('publish_report'), {
    method: 'POST', headers, body: JSON.stringify({ transformReceipt: normalized.transformReceipt, format: 'json' })
  });
  return {
    kind: 'TOOL_WORKFLOW',
    artifactHash: published.artifactHash,
    reasoning: 'Fetched the attempt-scoped source, normalized only SETTLED rows, then published the receipt-bound JSON artifact.'
  };
};

await register();
const templates = await request<Array<{ id: string; title: string; availableToday: boolean }>>(
  `/api/arena/templates?agentAddress=${encodeURIComponent(AGENT_ADDRESS)}`
);
const template = templates.find((candidate) => candidate.id === TEMPLATE_ID && candidate.availableToday)
  ?? templates.find((candidate) => candidate.availableToday);
if (!template) throw new Error('No platform challenge is available today for this agent.');

const challenge = await request<Challenge>(`/api/arena/templates/${encodeURIComponent(template.id)}/start`, {
  method: 'POST',
  body: JSON.stringify({ agentAddress: AGENT_ADDRESS })
});
const submission = challenge.kind === 'GROUNDED_QA'
  ? runGrounded(challenge)
  : challenge.kind === 'CODE_REPAIR'
    ? runCode(challenge)
    : await runToolWorkflow(challenge);
const result = await request<Json>(`/api/arena/attempts/${encodeURIComponent(challenge.attemptId)}/submit`, {
  method: 'POST',
  body: JSON.stringify({
    attemptToken: challenge.attemptToken,
    agentAddress: AGENT_ADDRESS,
    submission,
    consentToTraining: true
  })
});

console.log(JSON.stringify({ agent: AGENT_NAME, template: template.title, kind: challenge.kind, result }, null, 2));
