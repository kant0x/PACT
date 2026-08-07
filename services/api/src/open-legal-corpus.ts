import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Small, source-attributed seed corpus for the Open Legal Research quest.
 *
 * These are concise evaluation extracts, not a substitute for the official
 * opinions. Every source URL points to the Supreme Court's original PDF so
 * an agent can preserve a verifiable path back to the primary document.
 * The source material is a U.S. Government work; 17 U.S.C. § 105 applies.
 */
export interface OpenLegalCorpusDocument {
  documentId: string;
  title: string;
  docket: string;
  decidedAt: string;
  citation: string;
  sourceUrl: string;
  question: string;
  answer: string;
  chunks: Array<{
    chunkId: string;
    title: string;
    text: string;
  }>;
}

const starterDocuments: OpenLegalCorpusDocument[] = [
  {
    documentId: 'scotus-2025-tiktok-v-garland',
    title: 'TikTok Inc. v. Garland',
    docket: '24-656',
    decidedAt: '2025-01-17',
    citation: '604 U.S. 56 (2025)',
    sourceUrl: 'https://www.supremecourt.gov/opinions/24pdf/604us1r07_k536.pdf',
    question: 'In TikTok Inc. v. Garland, what level of First Amendment scrutiny did the Court apply to the challenged provisions?',
    answer: 'intermediate scrutiny',
    chunks: [
      {
        chunkId: 'scotus-2025-tiktok-v-garland#syllabus-holding',
        title: 'Syllabus / holding',
        text: 'Official source: TikTok Inc. v. Garland, 604 U.S. 56 (2025), No. 24-656. The Court held that the challenged provisions did not violate the petitioners\' First Amendment rights and applied intermediate scrutiny.'
      },
      {
        chunkId: 'scotus-2025-tiktok-v-garland#data-collection-rationale',
        title: 'Syllabus / rationale',
        text: 'Official source: TikTok Inc. v. Garland, 604 U.S. 56 (2025). The Court treated prevention of a foreign adversary collecting sensitive data from U.S. users as a content-neutral governmental interest; a qualified divestiture could avoid the statutory prohibitions.'
      }
    ]
  },
  {
    documentId: 'scotus-2025-emd-sales-v-carrera',
    title: 'E.M.D. Sales, Inc. v. Carrera',
    docket: '23-217',
    decidedAt: '2025-01-15',
    citation: '604 U.S. 45 (2025)',
    sourceUrl: 'https://www.supremecourt.gov/opinions/24pdf/604us1r06_5ifl.pdf',
    question: 'In E.M.D. Sales, Inc. v. Carrera, what standard of proof applies when an employer seeks to establish an FLSA exemption?',
    answer: 'preponderance of the evidence',
    chunks: [
      {
        chunkId: 'scotus-2025-emd-sales-v-carrera#syllabus-holding',
        title: 'Syllabus / holding',
        text: 'Official source: E.M.D. Sales, Inc. v. Carrera, 604 U.S. 45 (2025), No. 23-217. The Court held that the preponderance-of-the-evidence standard applies when an employer seeks to show that an employee is exempt from the FLSA minimum-wage and overtime provisions.'
      },
      {
        chunkId: 'scotus-2025-emd-sales-v-carrera#civil-default-rule',
        title: 'Opinion / civil-litigation rule',
        text: 'Official source: E.M.D. Sales, Inc. v. Carrera, 604 U.S. 45 (2025). The opinion describes preponderance as the ordinary civil standard and explains that the FLSA does not specify a heightened standard for exemptions.'
      }
    ]
  },
  {
    documentId: 'scotus-2025-wisconsin-bell-v-united-states',
    title: 'Wisconsin Bell, Inc. v. United States ex rel. Heath',
    docket: '23-1127',
    decidedAt: '2025-02-21',
    citation: '604 U.S. 140 (2025)',
    sourceUrl: 'https://www.supremecourt.gov/opinions/24pdf/604us1r10_mlio.pdf',
    question: 'In Wisconsin Bell, Inc. v. United States ex rel. Heath, did the E-Rate reimbursement requests qualify as claims under the False Claims Act?',
    answer: 'yes, they qualified as claims under the False Claims Act',
    chunks: [
      {
        chunkId: 'scotus-2025-wisconsin-bell-v-united-states#syllabus-holding',
        title: 'Syllabus / holding',
        text: 'Official source: Wisconsin Bell, Inc. v. United States ex rel. Heath, 604 U.S. 140 (2025), No. 23-1127. The Court held that the E-Rate reimbursement requests at issue were claims under the False Claims Act.'
      },
      {
        chunkId: 'scotus-2025-wisconsin-bell-v-united-states#treasury-funding',
        title: 'Syllabus / funding rationale',
        text: 'Official source: Wisconsin Bell, Inc. v. United States ex rel. Heath, 604 U.S. 140 (2025). The Court reasoned that the Government had provided a portion of the money by transferring more than $100 million from the Treasury into the relevant fund.'
      }
    ]
  },
  {
    documentId: 'scotus-2025-andrew-v-white',
    title: 'Andrew v. White, Warden',
    docket: '23-6573',
    decidedAt: '2025-01-21',
    citation: '604 U.S. 86 (2025)',
    sourceUrl: 'https://www.supremecourt.gov/opinions/24pdf/604us1r08_db8e.pdf',
    question: 'In Andrew v. White, what constitutional protection did the Court identify against unduly prejudicial evidence in a criminal trial?',
    answer: 'the Due Process Clause',
    chunks: [
      {
        chunkId: 'scotus-2025-andrew-v-white#syllabus-holding',
        title: 'Syllabus / holding',
        text: 'Official source: Andrew v. White, Warden, 604 U.S. 86 (2025), No. 23-6573. The Court held that clearly established law provided that the Due Process Clause forbids evidence so unduly prejudicial that it makes a criminal trial fundamentally unfair.'
      },
      {
        chunkId: 'scotus-2025-andrew-v-white#aedpa-rule',
        title: 'Opinion / AEDPA rule',
        text: 'Official source: Andrew v. White, Warden, 604 U.S. 86 (2025). The opinion treated the relevant legal principle as a holding for AEDPA purposes and vacated and remanded for further consideration.'
      }
    ]
  }
];

export interface OpenLegalCorpusRuntimeManifest {
  kind: 'manifest';
  schemaVersion: 1;
  corpusId: string;
  source: {
    provider: string;
    sourceUrl: string;
    retrievedAt: string;
    rights: string;
  };
}

export interface OpenLegalCorpusRuntimeCard extends OpenLegalCorpusDocument {
  kind: 'evaluation_card';
}

const MAX_RUNTIME_PACK_BYTES = 128 * 1024 * 1024;

/**
 * Source PDFs may occupy several gigabytes in object storage. The runtime
 * pack is deliberately much smaller: it contains only reviewed evidence
 * chunks and answer keys needed by the verifier, never the original archive.
 */
export const OPEN_LEGAL_CORPUS_SCALE = {
  targetDocuments: 5_000,
  targetDossierDocuments: 24,
  maxRuntimePackBytes: MAX_RUNTIME_PACK_BYTES,
  sourceProvider: 'Free Law Project / CourtListener bulk data',
  sourceDocumentationUrl: 'https://wiki.free.law/c/courtlistener/help/api/bulk-data/bulk-legal-data'
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const requiredText = (record: Record<string, unknown>, field: string, limit = 12_000) => {
  const value = record[field];
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`Open legal corpus ${field} is invalid`);
  return value.trim();
};

const requiredHttpsUrl = (record: Record<string, unknown>, field: string) => {
  const value = requiredText(record, field, 2_000);
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('not an https URL');
    return url.toString();
  } catch {
    throw new Error(`Open legal corpus ${field} must be a safe HTTPS URL`);
  }
};

const parseChunks = (value: unknown, documentId: string) => {
  if (!Array.isArray(value) || value.length < 2 || value.length > 24) throw new Error('Open legal corpus cards require 2-24 evidence chunks');
  const seen = new Set<string>();
  return value.map((item) => {
    if (!isRecord(item)) throw new Error('Open legal corpus chunk must be an object');
    const chunkId = requiredText(item, 'chunkId', 300);
    if (!chunkId.startsWith(`${documentId}#`) || seen.has(chunkId)) throw new Error('Open legal corpus chunkId must be unique and scoped to its document');
    seen.add(chunkId);
    return {
      chunkId,
      title: requiredText(item, 'title', 500),
      text: requiredText(item, 'text', 8_000)
    };
  });
};

/**
 * Parse an operator-created runtime pack. A legal challenge cannot become
 * live until it has source provenance, a reviewed answer, and two evidence
 * fragments that the verifier can check.
 */
export const parseOpenLegalCorpusRuntimePack = (content: string): OpenLegalCorpusDocument[] => {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 3) throw new Error('Open legal corpus runtime pack needs a manifest and at least two reviewed cards');
  const records = lines.map((line, index) => {
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) throw new Error('not an object');
      return parsed;
    } catch {
      throw new Error(`Open legal corpus runtime pack line ${index + 1} is not valid JSON`);
    }
  });
  const manifest = records[0]!;
  if (manifest.kind !== 'manifest' || manifest.schemaVersion !== 1) throw new Error('Open legal corpus runtime pack must start with schema version 1 manifest');
  requiredText(manifest, 'corpusId', 160);
  if (!isRecord(manifest.source)) throw new Error('Open legal corpus manifest requires source provenance');
  requiredText(manifest.source, 'provider', 300);
  requiredHttpsUrl(manifest.source, 'sourceUrl');
  requiredText(manifest.source, 'retrievedAt', 80);
  requiredText(manifest.source, 'rights', 1_000);

  const documents: OpenLegalCorpusDocument[] = [];
  const documentIds = new Set<string>();
  for (const record of records.slice(1)) {
    if (record.kind !== 'evaluation_card') throw new Error('Open legal corpus runtime pack supports reviewed evaluation_card records only');
    const documentId = requiredText(record, 'documentId', 300);
    if (documentIds.has(documentId)) throw new Error('Open legal corpus documentId must be unique');
    documentIds.add(documentId);
    documents.push({
      documentId,
      title: requiredText(record, 'title', 1_000),
      docket: requiredText(record, 'docket', 300),
      decidedAt: requiredText(record, 'decidedAt', 80),
      citation: requiredText(record, 'citation', 500),
      sourceUrl: requiredHttpsUrl(record, 'sourceUrl'),
      question: requiredText(record, 'question', 2_000),
      answer: requiredText(record, 'answer', 2_000),
      chunks: parseChunks(record.chunks, documentId)
    });
  }
  return documents;
};

const loadConfiguredRuntimePack = (): OpenLegalCorpusDocument[] => {
  const configuredPath = process.env.PACT_OPEN_LEGAL_CORPUS_PATH?.trim();
  if (!configuredPath) return starterDocuments;
  const runtimePackPath = resolve(configuredPath);
  if (!existsSync(runtimePackPath)) throw new Error(`PACT_OPEN_LEGAL_CORPUS_PATH does not exist: ${runtimePackPath}`);
  const size = statSync(runtimePackPath).size;
  if (size <= 0 || size > MAX_RUNTIME_PACK_BYTES) throw new Error(`PACT_OPEN_LEGAL_CORPUS_PATH must be between 1 byte and ${MAX_RUNTIME_PACK_BYTES} bytes`);
  return parseOpenLegalCorpusRuntimePack(readFileSync(runtimePackPath, 'utf8'));
};

/**
 * The production runtime either consumes an audited compact index supplied by
 * the operator, or falls back to the small official SCOTUS starter set.
 */
export const OPEN_LEGAL_CORPUS_DOCUMENTS = loadConfiguredRuntimePack();
