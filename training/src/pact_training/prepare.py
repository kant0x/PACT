from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .common import canonical_json, read_json, sha256_text, write_json, write_jsonl


SYSTEM_PROMPT = """You are an PACT autonomous work agent. Operate only inside the published task envelope. Check capability, task-value, concurrency, chain, action, and spending-policy limits before acting. Never claim authority to edit reputation, acceptance criteria, wallet policy, or finalized outcomes. Use visible tool actions, return a verifiable deliverable, and state uncertainty. Do not reveal secrets or private chain-of-thought."""

SECRET_PATTERNS = [
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----", re.IGNORECASE),
    re.compile(r"\b(?:sk|rk|pk)_[A-Za-z0-9_-]{24,}\b"),
    re.compile(r"\b0x[a-fA-F0-9]{64}\b"),
    re.compile(r"\b(?:mnemonic|seed phrase)\s*[:=]", re.IGNORECASE),
    re.compile(r"\b(?:api[_ -]?key|entity[_ -]?secret|password)\s*[:=]\s*\S+", re.IGNORECASE),
]


@dataclass(frozen=True)
class PreparedDataset:
    accepted: int
    rejected: int
    duplicates: int
    train: int
    evaluation: int
    manifest_path: Path


def _contains_secret(value: str) -> bool:
    return any(pattern.search(value) for pattern in SECRET_PATTERNS)


def _validate_trace(trace: dict[str, Any]) -> str | None:
    if trace.get("consentToTraining") is not True:
        return "missing_training_consent"
    if trace.get("outcome") != "SUCCESS":
        return "outcome_not_success"
    if not isinstance(trace.get("taskId"), str) or not trace["taskId"]:
        return "missing_task_id"
    messages = trace.get("messages")
    if not isinstance(messages, list) or len(messages) < 2:
        return "insufficient_visible_messages"
    for message in messages:
        if not isinstance(message, dict) or message.get("role") not in {"user", "assistant", "tool"}:
            return "invalid_message_role"
        content = message.get("content")
        if not isinstance(content, str) or not content.strip():
            return "empty_message"
        if _contains_secret(content):
            return "possible_secret"
    if _contains_secret(str(trace.get("deliverableSummary", ""))):
        return "possible_secret"
    return None


def _to_conversation(trace: dict[str, Any]) -> dict[str, Any]:
    visible_messages = [
        {
            "role": message["role"],
            "content": message["content"].strip(),
            **({"name": message["toolName"]} if message.get("toolName") else {}),
        }
        for message in trace["messages"]
    ]
    if visible_messages[-1]["role"] != "assistant":
        visible_messages.append({"role": "assistant", "content": trace["deliverableSummary"].strip()})
    messages = [{"role": "system", "content": SYSTEM_PROMPT}, *visible_messages]
    content_hash = sha256_text(canonical_json(messages))
    return {
        "messages": messages,
        "metadata": {
            "source": "PACT_FIRST_PARTY",
            "license": "CONSENTED_INTERNAL_TRAINING",
            "task_group": sha256_text(trace["taskId"]),
            "source_trace_hash": sha256_text(trace["id"]),
            "content_hash": content_hash,
            "tool_calls": len(trace.get("toolCalls", [])),
            "evidence_count": len(trace.get("evidence", [])),
        },
    }


def prepare_dataset(input_path: Path, output_dir: Path, eval_ratio: float = 0.15, seed: int = 42) -> PreparedDataset:
    if not 0.05 <= eval_ratio <= 0.5:
        raise ValueError("eval_ratio must be between 0.05 and 0.5")
    raw = read_json(input_path)
    if not isinstance(raw, list):
        raise ValueError("Trace export must contain a JSON array")

    accepted: list[dict[str, Any]] = []
    rejection_counts: dict[str, int] = {}
    seen_hashes: set[str] = set()
    duplicates = 0
    for trace in raw:
        if not isinstance(trace, dict):
            rejection_counts["not_an_object"] = rejection_counts.get("not_an_object", 0) + 1
            continue
        reason = _validate_trace(trace)
        if reason:
            rejection_counts[reason] = rejection_counts.get(reason, 0) + 1
            continue
        row = _to_conversation(trace)
        content_hash = row["metadata"]["content_hash"]
        if content_hash in seen_hashes:
            duplicates += 1
            continue
        seen_hashes.add(content_hash)
        accepted.append(row)

    # Split by task group, never by individual row, to prevent task leakage.
    threshold = int(eval_ratio * 10_000)
    train_rows: list[dict[str, Any]] = []
    eval_rows: list[dict[str, Any]] = []
    for row in accepted:
        group = row["metadata"]["task_group"]
        bucket = int(sha256_text(f"{seed}:{group}").split(":", 1)[1][:8], 16) % 10_000
        (eval_rows if bucket < threshold else train_rows).append(row)
    if len(accepted) > 1 and not eval_rows:
        eval_rows.append(train_rows.pop())
    if len(accepted) > 1 and not train_rows:
        train_rows.append(eval_rows.pop())

    output_dir.mkdir(parents=True, exist_ok=True)
    train_path = output_dir / "train.jsonl"
    eval_path = output_dir / "eval.jsonl"
    manifest_path = output_dir / "manifest.json"
    write_jsonl(train_path, train_rows)
    write_jsonl(eval_path, eval_rows)
    manifest = {
        "schemaVersion": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "source": "PACT_FIRST_PARTY",
        "inputHash": sha256_text(input_path.read_text(encoding="utf-8")),
        "trainHash": sha256_text(train_path.read_text(encoding="utf-8")),
        "evalHash": sha256_text(eval_path.read_text(encoding="utf-8")),
        "counts": {
            "input": len(raw),
            "accepted": len(accepted),
            "rejected": sum(rejection_counts.values()),
            "duplicates": duplicates,
            "train": len(train_rows),
            "eval": len(eval_rows),
        },
        "rejections": rejection_counts,
        "policies": {
            "consentRequired": True,
            "successfulOutcomesOnly": True,
            "privateReasoningExcluded": True,
            "secretScanEnabled": True,
            "groupedTaskSplit": True,
        },
    }
    write_json(manifest_path, manifest)
    return PreparedDataset(
        accepted=len(accepted),
        rejected=sum(rejection_counts.values()),
        duplicates=duplicates,
        train=len(train_rows),
        evaluation=len(eval_rows),
        manifest_path=manifest_path,
    )
