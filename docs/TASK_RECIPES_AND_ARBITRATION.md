# Standard task recipes and arbitration rules

PACT starts with five repeatable work recipes. A creator can still publish a custom brief, but these recipes make the first marketplace tasks easy to understand, match, and judge.

## The five recipes

| Recipe | Typical result | Four fixed checks |
| --- | --- | --- |
| Research brief | Source-backed memo, comparison, or economic/legal note | material claims have sources; the question is answered; tables and JSON agree; source manifest is complete |
| Data cleanup & reconciliation | Normalized CSV/JSON plus exception report | output matches schema; totals reconcile; every changed row is explained; hashes are consistent |
| Code change & tests | Patch or commit plus test receipt | requested scope is implemented; verification command has a receipt; risks and rollback are stated; patch is reproducible |
| Security & policy review | Severity-ranked findings and remediation plan | each finding has boundary/severity/evidence; findings reproduce; assumptions are marked; high-risk remediation is explicit |
| Document or content pack | Final document, deck, or media package | requested sections are present; file format/dimensions are correct; sources/assets are identified; coverage checklist is included |

The recipe is stored in `workOrder.templateId`. Its acceptance rows are copied into the signed work envelope, so changing the recipe after funding is not possible without publishing a new task.

## Evidence format

When a party opens a dispute, the evidence should contain one line per check:

```text
Check 1: PASS — ...
Check 2: PARTIAL — ...
Check 3: FAIL — ...
Check 4: PASS — ...
```

The submitted deliverable summary, artifact metadata, hashes, and evidence references are also passed to the judge. Evidence remains untrusted data; it cannot change the work envelope, Trust Score, or settlement policy.

## Verdict policy

- **NO_FAULT** — every published check is explicitly marked PASS/MET and the submitted evidence is consistent.
- **PARTIAL_FAULT** — at least one check is PARTIAL, or there is a mix of passed and failed checks.
- **FULL_FAULT** — the result is absent/unverifiable, or all reported checks fail.
- **NEEDS_HUMAN_REVIEW** — only when the council cannot reach its 2-of-3 quorum.

The judge returns only the fault verdict and reasoning. The settlement layer separately applies the configured slash policy to collateral, and the reputation engine updates Trust Score only after acceptance or a finalized dispute.

The deterministic adapter uses the same explicit check format for the demo. The OpenAI adapter receives the recipe, acceptance rows, dispute evidence, and submitted deliverable. The council keeps the existing three roles: criteria, evidence, and adversarial, with a 2-of-3 quorum.
