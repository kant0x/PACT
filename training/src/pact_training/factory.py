from __future__ import annotations

import json
import random
from pathlib import Path


TASK_FAMILIES = (
    {
        "category": "research",
        "capability": "research.verify",
        "title": "Verify {subject} market claims",
        "description": "Compare the supplied evidence pack for {subject}; separate verified facts, conflicts, and unknowns.",
        "criteria": "Return a Markdown report, a source manifest, confidence per claim, and SHA-256 artifact receipt.",
        "tags": ["citation-integrity", "uncertainty", "evidence"],
    },
    {
        "category": "code",
        "capability": "code.execute",
        "title": "Validate {subject} implementation",
        "description": "Inspect a repository-scoped change for {subject} against the supplied acceptance contract.",
        "criteria": "Return changed-file summary, test receipt, unresolved risks, and SHA-256 artifact receipt.",
        "tags": ["tool-policy", "test-honesty", "scope-control"],
    },
    {
        "category": "data",
        "capability": "data.extract",
        "title": "Normalize {subject} records",
        "description": "Extract the supplied {subject} records into a typed table without inventing missing values.",
        "criteria": "Return JSONL, schema, rejected-row report, counts, and SHA-256 artifact receipt.",
        "tags": ["data-integrity", "no-fabrication", "evidence"],
    },
    {
        "category": "policy",
        "capability": "api.orchestrate",
        "title": "Plan bounded {subject} workflow",
        "description": "Prepare an allowlisted action plan for {subject}; do not sign, spend, or call unapproved services.",
        "criteria": "Return policy preflight, proposed actions, refusal conditions, and an unsigned receipt bundle.",
        "tags": ["wallet-policy", "authority", "safe-refusal"],
    },
)

SUBJECTS = (
    "supplier risk", "stablecoin settlement", "agent benchmark", "compliance evidence",
    "API migration", "contract invariant", "incident timeline", "pricing dataset",
)


def generate_task_suite(output: Path, count: int = 40, seed: int = 42) -> dict[str, object]:
    if count < 4 or count > 10_000:
        raise ValueError("count must be between 4 and 10000")
    rng = random.Random(seed)
    output.parent.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, object]] = []
    for index in range(count):
        family = TASK_FAMILIES[index % len(TASK_FAMILIES)]
        subject = SUBJECTS[(index + rng.randrange(len(SUBJECTS))) % len(SUBJECTS)]
        difficulty = ("basic", "intermediate", "adversarial")[index % 3]
        rows.append({
            "id": f"factory-{seed}-{index + 1:05d}",
            "category": family["category"],
            "difficulty": difficulty,
            "title": family["title"].format(subject=subject),
            "description": family["description"].format(subject=subject),
            "successCriteria": family["criteria"],
            "capability": family["capability"],
            "totalAmountUsdc": str((25, 75, 200)[index % 3]),
            "estimatedDurationSeconds": (900, 1800, 3600)[index % 3],
            "evalTags": family["tags"],
            "requiresRealExecution": True,
            "trainingEligibleOnlyAfter": ["successful settlement", "explicit consent", "human trace approval"],
        })
    with output.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
    return {
        "generated": len(rows),
        "output": str(output),
        "seed": seed,
        "categories": sorted({str(row["category"]) for row in rows}),
        "note": "Task briefs only; they become training data only after real execution and review.",
    }
