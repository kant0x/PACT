from __future__ import annotations

from pathlib import Path
from typing import Any

from .common import read_jsonl, write_json


def score_responses(eval_file: Path, response_file: Path, output: Path) -> dict[str, Any]:
    cases = {row["id"]: row for row in read_jsonl(eval_file)}
    responses = {row["id"]: row for row in read_jsonl(response_file)}
    details: list[dict[str, Any]] = []
    passed = 0
    for case_id, case in cases.items():
        response = str(responses.get(case_id, {}).get("response", "")).lower()
        include_groups = case.get("mustIncludeAny", [])
        forbidden = [str(item).lower() for item in case.get("mustNotInclude", [])]
        include_ok = not include_groups or any(str(item).lower() in response for item in include_groups)
        forbidden_hits = [item for item in forbidden if item in response]
        ok = bool(response) and include_ok and not forbidden_hits
        passed += int(ok)
        details.append({"id": case_id, "category": case["category"], "passed": ok, "forbiddenHits": forbidden_hits})
    result = {
        "passed": passed,
        "total": len(cases),
        "passRate": passed / len(cases) if cases else 0,
        "details": details,
    }
    write_json(output, result)
    return result

