import { createHash } from 'node:crypto';
import type {
  ArenaDocumentKind,
  ArenaQuestionView,
  ArenaTemplate
} from '@pact/shared';

export type ArenaQuestionRule =
  | { type: 'EXACT'; accepted: string[] }
  | { type: 'NUMBER'; expected: number; tolerance: number }
  | { type: 'KEYWORDS'; required: string[] };

export interface ArenaPrivateQuestion extends ArenaQuestionView {
  rule: ArenaQuestionRule;
}

export interface ArenaDocumentRecord {
  id: string;
  templateId: string;
  title: string;
  kind: ArenaDocumentKind;
  sourceName: string;
  sourceUrl: string;
  publishedAt: string;
  content: string;
  contentHash: string;
  notice: string;
  questions: ArenaPrivateQuestion[];
  builtIn: boolean;
  createdAt: number;
}

export interface ArenaTemplateRecord {
  id: string;
  title: string;
  description: string;
  documentKind: ArenaDocumentKind;
  rewardPoints: number;
  ownerType: 'PLATFORM';
  ownerName: string;
  isActive: boolean;
}

export interface AddArenaDocumentInput {
  templateId: string;
  title: string;
  kind: ArenaDocumentKind;
  sourceName: string;
  sourceUrl: string;
  publishedAt: string;
  content: string;
  questions: Array<{
    id: string;
    prompt: string;
    answerFormat: 'TEXT' | 'NUMBER';
    weight: number;
    rule: ArenaQuestionRule;
  }>;
}


export const BUILT_IN_ARENA_TEMPLATES: ArenaTemplateRecord[] = [
  {
    id: 'daily-economic-document-v1',
    title: 'Daily economic document',
    description: 'Read a source-verified economic release, extract the reported values, and answer without inventing missing facts.',
    documentKind: 'ECONOMIC',
    rewardPoints: 30,
    ownerType: 'PLATFORM',
    ownerName: 'PACT Platform',
    isActive: true
  },
  {
    id: 'daily-court-document-v1',
    title: 'Daily court record',
    description: 'Read a source-verified court record and identify the parties, procedural facts, and holding stated in the document.',
    documentKind: 'LEGAL',
    rewardPoints: 40,
    ownerType: 'PLATFORM',
    ownerName: 'PACT Platform',
    isActive: true
  }
];

const economicDocuments: Omit<ArenaDocumentRecord, 'contentHash' | 'builtIn' | 'createdAt'>[] = [
  {
    id: 'bls-cpi-2025-01',
    templateId: 'daily-economic-document-v1',
    title: 'Consumer Price Index — January 2025',
    kind: 'ECONOMIC',
    sourceName: 'U.S. Bureau of Labor Statistics',
    sourceUrl: 'https://www.bls.gov/news.release/archives/cpi_02122025.htm',
    publishedAt: '2025-02-12',
    content: [
      'Verified extract from the official January 2025 CPI release.',
      'The CPI for All Urban Consumers increased 0.5 percent on a seasonally adjusted basis in January. Over the preceding 12 months, the all-items index increased 3.0 percent before seasonal adjustment.',
      'Shelter increased 0.4 percent during the month and accounted for nearly 30 percent of the monthly all-items increase. Energy increased 1.1 percent, gasoline increased 1.8 percent, and food increased 0.4 percent.',
      'The index excluding food and energy increased 0.4 percent during January and 3.3 percent over the preceding 12 months.'
    ].join('\n\n'),
    notice: 'Source-verified educational extract. Use the supplied document as the only answer authority.',
    questions: [
      { id: 'monthly-cpi', prompt: 'What was the seasonally adjusted monthly CPI-U change in January 2025?', answerFormat: 'NUMBER', weight: 25, rule: { type: 'NUMBER', expected: 0.5, tolerance: 0.001 } },
      { id: 'annual-cpi', prompt: 'What was the 12-month all-items CPI change?', answerFormat: 'NUMBER', weight: 25, rule: { type: 'NUMBER', expected: 3.0, tolerance: 0.001 } },
      { id: 'annual-core', prompt: 'What was the 12-month change for all items excluding food and energy?', answerFormat: 'NUMBER', weight: 25, rule: { type: 'NUMBER', expected: 3.3, tolerance: 0.001 } },
      { id: 'largest-contributor', prompt: 'Which index accounted for nearly 30 percent of the monthly all-items increase?', answerFormat: 'TEXT', weight: 25, rule: { type: 'EXACT', accepted: ['shelter', 'shelter index', 'the shelter index'] } }
    ]
  },
  {
    id: 'fomc-2025-01-29',
    templateId: 'daily-economic-document-v1',
    title: 'Federal Open Market Committee statement — January 29, 2025',
    kind: 'ECONOMIC',
    sourceName: 'Board of Governors of the Federal Reserve System',
    sourceUrl: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20250129a.htm',
    publishedAt: '2025-01-29',
    content: [
      'Verified extract from the official January 29, 2025 FOMC statement.',
      'The Committee described economic activity as expanding at a solid pace, labor-market conditions as solid, and inflation as somewhat elevated.',
      'It maintained the target range for the federal funds rate at 4.25 to 4.50 percent. Its longer-run inflation objective remained 2 percent.',
      'The Committee also said it would continue reducing its holdings of Treasury securities, agency debt, and agency mortgage-backed securities.'
    ].join('\n\n'),
    notice: 'Source-verified educational extract. It is not investment advice or a current policy statement.',
    questions: [
      { id: 'range-lower', prompt: 'What was the lower bound of the federal funds target range, in percent?', answerFormat: 'NUMBER', weight: 25, rule: { type: 'NUMBER', expected: 4.25, tolerance: 0.001 } },
      { id: 'range-upper', prompt: 'What was the upper bound of the federal funds target range, in percent?', answerFormat: 'NUMBER', weight: 25, rule: { type: 'NUMBER', expected: 4.5, tolerance: 0.001 } },
      { id: 'inflation-objective', prompt: 'What was the Committee’s longer-run inflation objective, in percent?', answerFormat: 'NUMBER', weight: 25, rule: { type: 'NUMBER', expected: 2, tolerance: 0.001 } },
      { id: 'holdings', prompt: 'Name the three categories of holdings the Committee said it would continue reducing.', answerFormat: 'TEXT', weight: 25, rule: { type: 'KEYWORDS', required: ['treasury securities', 'agency debt', 'agency mortgage-backed securities'] } }
    ]
  },
  {
    id: 'bea-gdp-2024-q4-second',
    templateId: 'daily-economic-document-v1',
    title: 'GDP, fourth quarter 2024 — second estimate',
    kind: 'ECONOMIC',
    sourceName: 'U.S. Bureau of Economic Analysis',
    sourceUrl: 'https://www.bea.gov/news/2025/gross-domestic-product-4th-quarter-and-year-2024-second-estimate',
    publishedAt: '2025-02-27',
    content: [
      'Verified extract from the BEA second estimate for the fourth quarter of 2024.',
      'Real GDP increased at an annual rate of 2.3 percent in the fourth quarter. In the third quarter, real GDP had increased 3.1 percent.',
      'The fourth-quarter increase primarily reflected increases in consumer spending and government spending, partly offset by a decrease in investment.',
      'The PCE price index increased 2.4 percent. Excluding food and energy, the PCE price index increased 2.7 percent. Real GDP increased 2.8 percent for the full year 2024.'
    ].join('\n\n'),
    notice: 'Source-verified educational extract. Values belong to the named historical estimate and may later have been revised.',
    questions: [
      { id: 'q4-real-gdp', prompt: 'At what annual rate did real GDP increase in the fourth quarter of 2024?', answerFormat: 'NUMBER', weight: 25, rule: { type: 'NUMBER', expected: 2.3, tolerance: 0.001 } },
      { id: 'q3-real-gdp', prompt: 'What real GDP growth rate was reported for the third quarter?', answerFormat: 'NUMBER', weight: 25, rule: { type: 'NUMBER', expected: 3.1, tolerance: 0.001 } },
      { id: 'core-pce', prompt: 'What was the PCE price-index increase excluding food and energy?', answerFormat: 'NUMBER', weight: 25, rule: { type: 'NUMBER', expected: 2.7, tolerance: 0.001 } },
      { id: 'offset', prompt: 'Which component decreased and partly offset increases in consumer and government spending?', answerFormat: 'TEXT', weight: 25, rule: { type: 'EXACT', accepted: ['investment', 'a decrease in investment'] } }
    ]
  }
];

const legalDocuments: Omit<ArenaDocumentRecord, 'contentHash' | 'builtIn' | 'createdAt'>[] = [
  {
    id: 'scotus-sec-v-jarkesy-2024',
    templateId: 'daily-court-document-v1',
    title: 'SEC v. Jarkesy, 603 U.S. (2024)',
    kind: 'LEGAL',
    sourceName: 'Supreme Court of the United States',
    sourceUrl: 'https://www.supremecourt.gov/opinions/23pdf/22-859_1924.pdf',
    publishedAt: '2024-06-27',
    content: [
      'Verified extract from the syllabus of SEC v. Jarkesy, docket 22-859.',
      'The SEC brought an in-house enforcement action against George Jarkesy Jr. and Patriot28 LLC for alleged securities fraud and imposed a civil penalty of $300,000.',
      'The Fifth Circuit vacated the order. The Supreme Court held that when the SEC seeks civil penalties for securities fraud, the Seventh Amendment entitles the defendant to a jury trial.',
      'The decision was issued on June 27, 2024.'
    ].join('\n\n'),
    notice: 'Source-verified educational extract. It is not legal advice and omits the full opinion and dissents.',
    questions: [
      { id: 'docket', prompt: 'What was the Supreme Court docket number?', answerFormat: 'TEXT', weight: 25, rule: { type: 'EXACT', accepted: ['22-859', '22“859', 'no. 22-859', 'no. 22“859'] } },
      { id: 'penalty', prompt: 'What civil penalty amount did the SEC impose, in U.S. dollars?', answerFormat: 'NUMBER', weight: 25, rule: { type: 'NUMBER', expected: 300000, tolerance: 0.01 } },
      { id: 'amendment', prompt: 'Which constitutional amendment supplied the jury-trial right?', answerFormat: 'TEXT', weight: 25, rule: { type: 'EXACT', accepted: ['seventh amendment', 'the seventh amendment', '7th amendment', 'amendment vii'] } },
      { id: 'holding', prompt: 'What type of trial did the Court hold the defendant was entitled to?', answerFormat: 'TEXT', weight: 25, rule: { type: 'EXACT', accepted: ['jury trial', 'a jury trial', 'trial by jury'] } }
    ]
  },
  {
    id: 'scotus-loper-bright-2024',
    templateId: 'daily-court-document-v1',
    title: 'Loper Bright Enterprises v. Raimondo, 603 U.S. (2024)',
    kind: 'LEGAL',
    sourceName: 'Supreme Court of the United States',
    sourceUrl: 'https://www.supremecourt.gov/opinions/23pdf/22-451_7m58.pdf',
    publishedAt: '2024-06-28',
    content: [
      'Verified extract from the syllabus and opinion in Loper Bright Enterprises v. Raimondo, docket 22-451.',
      'The case concerned whether courts must defer under Chevron to a permissible agency interpretation of an ambiguous statute.',
      'The Court held that the Administrative Procedure Act requires courts to exercise independent judgment when deciding whether an agency acted within its statutory authority. Courts may not defer merely because a statute is ambiguous, and Chevron was overruled.',
      'The decision was issued on June 28, 2024.'
    ].join('\n\n'),
    notice: 'Source-verified educational extract. It is not legal advice and omits the full opinions.',
    questions: [
      { id: 'docket', prompt: 'What was the docket number identified for Loper Bright?', answerFormat: 'TEXT', weight: 25, rule: { type: 'EXACT', accepted: ['22-451', '22“451', 'no. 22-451', 'no. 22“451'] } },
      { id: 'statute', prompt: 'Which federal statute did the Court say requires independent judicial judgment?', answerFormat: 'TEXT', weight: 25, rule: { type: 'EXACT', accepted: ['administrative procedure act', 'the administrative procedure act', 'apa'] } },
      { id: 'doctrine', prompt: 'Which doctrine or precedent did the Court overrule?', answerFormat: 'TEXT', weight: 25, rule: { type: 'KEYWORDS', required: ['chevron'] } },
      { id: 'decision-maker', prompt: 'Who must exercise independent judgment on statutory authority?', answerFormat: 'TEXT', weight: 25, rule: { type: 'EXACT', accepted: ['courts', 'the courts', 'court', 'a court', 'reviewing courts'] } }
    ]
  },
  {
    id: 'scotus-coinbase-v-suski-2024',
    templateId: 'daily-court-document-v1',
    title: 'Coinbase, Inc. v. Suski, 602 U.S. (2024)',
    kind: 'LEGAL',
    sourceName: 'Supreme Court of the United States',
    sourceUrl: 'https://www.supremecourt.gov/opinions/23pdf/23-3_879d.pdf',
    publishedAt: '2024-05-23',
    content: [
      'Verified extract from the syllabus of Coinbase, Inc. v. Suski, docket 23-3.',
      'The parties had two contracts. A user agreement delegated arbitrability disputes to an arbitrator, while later sweepstakes rules selected California courts for disputes concerning the promotion.',
      'The Supreme Court held that when two contracts conflict over who decides arbitrability, a court must decide which contract governs. The Court affirmed the Ninth Circuit.',
      'The unanimous decision was issued on May 23, 2024.'
    ].join('\n\n'),
    notice: 'Source-verified educational extract. It is not legal advice and omits the full opinion.',
    questions: [
      { id: 'docket', prompt: 'What was the docket number?', answerFormat: 'TEXT', weight: 25, rule: { type: 'EXACT', accepted: ['23-3', '23“3', 'no. 23-3', 'no. 23“3'] } },
      { id: 'forum', prompt: 'Which courts were selected by the sweepstakes rules?', answerFormat: 'TEXT', weight: 25, rule: { type: 'KEYWORDS', required: ['california', 'courts'] } },
      { id: 'decider', prompt: 'Who must decide which of the conflicting contracts governs?', answerFormat: 'TEXT', weight: 25, rule: { type: 'EXACT', accepted: ['court', 'a court', 'the court', 'courts'] } },
      { id: 'circuit', prompt: 'Which circuit’s judgment was affirmed?', answerFormat: 'TEXT', weight: 25, rule: { type: 'EXACT', accepted: ['ninth circuit', 'the ninth circuit', '9th circuit'] } }
    ]
  }
];

export const sha256 = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

export const BUILT_IN_ARENA_DOCUMENTS: ArenaDocumentRecord[] = [...economicDocuments, ...legalDocuments].map((document) => ({
  ...document,
  contentHash: sha256(document.content),
  builtIn: true,
  createdAt: 1_735_689_600
}));

export const utcDayKey = (timestampSeconds = Math.floor(Date.now() / 1000)) => new Date(timestampSeconds * 1000).toISOString().slice(0, 10);

export const nextUtcDaySeconds = (timestampSeconds = Math.floor(Date.now() / 1000)) => {
  const date = new Date(timestampSeconds * 1000);
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1) / 1000);
};

export const stableIndex = (key: string, length: number) => {
  if (length <= 1) return 0;
  return Number.parseInt(createHash('sha256').update(key).digest('hex').slice(0, 8), 16) % length;
};

export const publicTemplate = (
  template: ArenaTemplateRecord,
  documentPoolSize: number,
  completedToday: boolean,
  timestampSeconds = Math.floor(Date.now() / 1000)
): ArenaTemplate => ({
  ...template,
  evaluationMode: 'DETERMINISTIC',
  documentPoolSize,
  availableToday: template.isActive && !completedToday,
  completedToday,
  nextAttemptAt: nextUtcDaySeconds(timestampSeconds)
});

export const publicQuestion = ({ rule: _rule, ...question }: ArenaPrivateQuestion): ArenaQuestionView => ({ ...question });

const normalizeText = (value: string) => value
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[–—]/g, '-')
  .replace(/[$,%]/g, '')
  .replace(/[^\p{L}\p{N}.\-\s]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const parseNumericAnswer = (value: string) => {
  const normalized = value.replace(/,/g, '').replace(/[%$]/g, ' ');
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : Number.NaN;
};

export const evaluateArenaAnswer = (question: ArenaPrivateQuestion, answer: string) => {
  if (question.rule.type === 'NUMBER') {
    const value = parseNumericAnswer(answer);
    return Number.isFinite(value) && Math.abs(value - question.rule.expected) <= question.rule.tolerance ? 100 : 0;
  }
  const normalized = normalizeText(answer);
  if (question.rule.type === 'EXACT') {
    return question.rule.accepted.some((candidate) => normalizeText(candidate) === normalized) ? 100 : 0;
  }
  const matched = question.rule.required.filter((keyword) => normalized.includes(normalizeText(keyword))).length;
  return Math.round((matched / question.rule.required.length) * 100);
};


