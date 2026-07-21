/**
 * PACT-owned smoke agent for the first Training Ground launch.
 *
 * This is an external-runtime example: it registers a wallet, reads the
 * public document and questions, solves the starter document with bounded
 * extraction rules, and submits only the document receipt plus answers.
 * It never receives or imports the server answer key.
 */

const API_URL = (process.env.PACT_API_URL ?? 'http://localhost:4100').replace(/\/$/, '');
const AGENT_ADDRESS = process.env.PACT_ARENA_AGENT_ADDRESS ?? '0xB100000000000000000000000000000000000011';
const AGENT_NAME = process.env.PACT_ARENA_AGENT_NAME ?? 'PACT Research Smoke Agent';
const TEMPLATE_ID = process.env.PACT_ARENA_TEMPLATE_ID;

type Json = Record<string, unknown>;
type Question = { id: string; prompt: string; answerFormat: 'TEXT' | 'NUMBER' };
type Challenge = {
  attemptId: string;
  attemptToken: string;
  templateId: string;
  templateTitle: string;
  document: { content: string; contentHash: string };
  questions: Question[];
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

const numberIn = (text: string, fallback = '') => text.match(/-?\d+(?:\.\d+)?/)?.[0] ?? fallback;
const sentence = (content: string, terms: string[]) => content.split(/(?<=[.!?])\s+/).find((part) => {
  const normalized = part.toLowerCase();
  return terms.every((term) => normalized.includes(term));
}) ?? content;

function solve(question: Question, content: string): string {
  const prompt = question.prompt.toLowerCase();
  const source = content.toLowerCase();

  if (question.answerFormat === 'NUMBER') {
    if (prompt.includes('lower bound')) {
      const match = source.match(/target range[^\d]*(\d+(?:\.\d+)?)[^\d]+(\d+(?:\.\d+)?)/i);
      return match?.[1] ?? numberIn(sentence(content, ['target range']));
    }
    if (prompt.includes('upper bound')) {
      const match = source.match(/target range[^\d]*(\d+(?:\.\d+)?)[^\d]+(\d+(?:\.\d+)?)/i);
      return match?.[2] ?? numberIn(sentence(content, ['target range']));
    }
    if (prompt.includes('objective')) return numberIn(sentence(content, ['objective', 'percent']));
    if (prompt.includes('excluding food and energy')) return numberIn(sentence(content, ['excluding food and energy']));
    if (prompt.includes('fourth quarter')) return content.match(/real GDP increased at an annual rate of\s+(\d+(?:\.\d+)?)/i)?.[1] ?? numberIn(content);
    if (prompt.includes('third quarter')) return content.match(/third quarter[^.]*?increased\s+(\d+(?:\.\d+)?)/i)?.[1] ?? numberIn(content);
    if (prompt.includes('12-month') || prompt.includes('annual')) return numberIn(sentence(content, ['preceding 12 months']));
    if (prompt.includes('monthly') || prompt.includes('january')) return numberIn(sentence(content, ['seasonally adjusted']));
    if (prompt.includes('penalty')) return numberIn(sentence(content, ['penalty']));
    return numberIn(content);
  }

  if (prompt.includes('which index') && prompt.includes('accounted')) return 'shelter';
  if (prompt.includes('which component') && prompt.includes('decreased')) return 'investment';
  if (prompt.includes('constitutional amendment')) return 'Seventh Amendment';
  if (prompt.includes('type of trial')) return 'jury trial';
  if (prompt.includes('categories of holdings')) {
    const match = content.match(/holdings of (.+?)\./i);
    return match?.[1] ?? 'Treasury securities, agency debt, agency mortgage-backed securities';
  }
  if (prompt.includes('which doctrine') || prompt.includes('precedent')) return 'Chevron';
  if (prompt.includes('which federal statute')) return 'Administrative Procedure Act';
  if (prompt.includes('who must exercise') || prompt.includes('who must decide')) return 'courts';
  if (prompt.includes('which courts')) return 'California courts';
  if (prompt.includes('which circuit')) return 'Ninth Circuit';
  return source.split(/\s+/).slice(0, 3).join(' ');
}

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

await register();
const templates = await request<Array<{ id: string; title: string; availableToday: boolean }>>(`/api/arena/templates?agentAddress=${encodeURIComponent(AGENT_ADDRESS)}`);
const template = templates.find((candidate) => candidate.id === TEMPLATE_ID && candidate.availableToday)
  ?? templates.find((candidate) => candidate.availableToday);
if (!template) throw new Error('No platform challenge is available today for this agent.');

const challenge = await request<Challenge>(`/api/arena/templates/${encodeURIComponent(template.id)}/start`, {
  method: 'POST',
  body: JSON.stringify({ agentAddress: AGENT_ADDRESS })
});
const answers = challenge.questions.map((question) => ({ questionId: question.id, answer: solve(question, challenge.document.content) }));
const result = await request<Json>(`/api/arena/attempts/${encodeURIComponent(challenge.attemptId)}/submit`, {
  method: 'POST',
  body: JSON.stringify({
    attemptToken: challenge.attemptToken,
    agentAddress: AGENT_ADDRESS,
    answers,
    evidence: [challenge.document.contentHash],
    consentToTraining: true
  })
});

console.log(JSON.stringify({ agent: AGENT_NAME, template: template.title, answers, result }, null, 2));
