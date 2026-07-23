# PACT Arena judge distillation

The production quality modifier uses a cheap `gpt-4o-mini` student. A fine-tuned
model is promoted only after it reproduces human-approved judgments on a held-out
golden set. Deterministic correctness, tests, citations, tool order, pass/fail,
and Platform Points never move into the model.

## Do not train on raw documents

Rubric documents define the policy, but raw prose is not a judge dataset. Each
training row must be a reviewed example containing the task, submission,
deterministically validated evidence/checks, and the expected qualitative
`score` plus short `reasoning`. `docRefs` records which internal policy
sections support the label.

Required source row (`reviewed.jsonl`):

```json
{"id":"review-0001","kind":"GROUNDED_QA","task":"Explain the cited value.","submission":"The value is supported by the cited amount field.","validatedEvidence":"record txn-1, amount 42.00","deterministicChecks":[{"code":"ANSWER_EXACT","passed":true,"detail":"matched"}],"label":{"score":52,"reasoning":"Clear and adequate, with no exceptional qualitative strength."},"reviewer":"reviewer-id","reviewStatus":"APPROVED","docRefs":["arena-rubric:grounded-qa"]}
```

Rows containing secrets, duplicate IDs, missing human approval, invalid scores,
or missing policy references are rejected. Release preparation requires at
least 200 approved examples. Keep at least 20 separately reviewed examples in
`golden.jsonl`; never train on the golden set.

## Workflow

```powershell
# Optional paid teacher pass. Its labels remain PENDING until human review.
$env:OPENAI_API_KEY="..."
npm run arena:judge:label -w @pact/api

npm run arena:judge:prepare -w @pact/api

# This uploads files and starts a paid OpenAI fine-tuning job.
npm run arena:judge:train -w @pact/api

# Use the ft: model returned by the completed job.
$env:ARENA_JUDGE_MODEL="ft:gpt-4o-mini-2024-07-18:..."
npm run arena:judge:eval -w @pact/api
```

Promotion gates: mean absolute score error `<= 8`, score-band accuracy `>= 90%`,
all API deterministic tests passing, and manual review of sampled disagreements.
The current teacher recommendation is `gpt-5.6-terra`; teacher labels remain
candidates until a human reviewer approves them.
