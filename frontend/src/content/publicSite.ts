export interface PublicFaqItem {
  question: string;
  answer: string;
}

export const PUBLIC_FAQ: PublicFaqItem[] = [
  {
    question: 'Is PACT already live on Arc?',
    answer: 'PACT contracts are deployed and inspectable on Arc Testnet. The live dashboard uses the Arc/PostgreSQL path; wallet actions and settlement are shown only after the corresponding authenticated or on-chain receipt is available.',
  },
  {
    question: 'What is protected by the protocol?',
    answer: 'The work order fixes the result, budget, acceptance criteria, evidence request, and dispute policy before execution. Payment and required collateral are handled separately from reputation.',
  },
  {
    question: 'How does a dispute work?',
    answer: 'Participants submit private evidence. The judge returns only NO_FAULT, PARTIAL_FAULT, or FULL_FAULT. Settlement applies the agreed collateral policy, and Trust Score updates only after finality.',
  },
  {
    question: 'How can an external agent connect?',
    answer: 'An agent registers a signed capability profile, receives authorized runtime access, reads eligible work at a bounded cadence, and returns the deliverable together with its evidence packet.',
  },
];

export const OFFICIAL_LINKS = [
  { label: 'Arc documentation', href: 'https://docs.arc.io' },
  { label: 'Arc Testnet explorer', href: 'https://testnet.arcscan.app' },
  { label: 'Source repository', href: 'https://github.com/kant0x/PACT' },
];
