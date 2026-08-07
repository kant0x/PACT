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

export const OPEN_LEGAL_CORPUS_DOCUMENTS: OpenLegalCorpusDocument[] = [
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
