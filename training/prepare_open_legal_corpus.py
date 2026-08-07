#!/usr/bin/env python3
"""Prepare reviewed CourtListener bulk data for PACT's legal evidence runs.

The raw CourtListener archive can be several gigabytes. This tool never sends
that archive to an agent: it produces a compact JSONL runtime pack containing
only source-attributed, reviewer-approved evidence cards. The API validates the
same pack again before it will use it for a live training run.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


DEFAULT_SOURCE_URL = "https://wiki.free.law/c/courtlistener/help/api/bulk-data/bulk-legal-data"
DEFAULT_RIGHTS = "CourtListener bulk data is published as free of known copyright restrictions."


def text(row: dict[str, str], *names: str) -> str:
    for name in names:
        value = row.get(name, "")
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def read_csv_rows(path: Path) -> Iterable[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as source:
        yield from csv.DictReader(source)


def normalize_body(raw: str) -> str:
    value = re.sub(r"<(?:script|style)[^>]*>.*?</(?:script|style)>", " ", raw, flags=re.IGNORECASE | re.DOTALL)
    value = re.sub(r"<[^>]+>", " ", value)
    value = html.unescape(value)
    return re.sub(r"\s+", " ", value).strip()


def make_evidence_chunks(body: str, selectors: list[str], document_id: str) -> list[dict[str, str]]:
    chunks: list[dict[str, str]] = []
    used_windows: list[tuple[int, int]] = []
    lower_body = body.lower()
    for selector in selectors:
        position = lower_body.find(selector.lower())
        if position < 0:
            raise ValueError(f"reviewed selector not found in source text: {selector!r}")
        start = max(0, position - 700)
        end = min(len(body), position + len(selector) + 900)
        # Keep chunks readable by favouring sentence boundaries near the window.
        previous_stop = body.rfind(". ", max(0, start - 250), start)
        next_stop = body.find(". ", end, min(len(body), end + 250))
        if previous_stop >= 0:
            start = previous_stop + 2
        if next_stop >= 0:
            end = next_stop + 1
        if any(start >= left and end <= right for left, right in used_windows):
            continue
        used_windows.append((start, end))
        chunks.append({
            "chunkId": f"{document_id}#evidence-{len(chunks) + 1}",
            "title": f"Reviewed evidence {len(chunks) + 1}",
            "text": body[start:end].strip(),
        })
    if len(chunks) < 2:
        raise ValueError("each reviewed card needs two distinct evidence selectors")
    return chunks


def read_reviewed_cards(path: Path) -> dict[str, dict[str, Any]]:
    cards: dict[str, dict[str, Any]] = {}
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            card = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"reviewed cards line {line_number} is not JSON") from error
        if not isinstance(card, dict):
            raise ValueError(f"reviewed cards line {line_number} must be an object")
        opinion_id = str(card.get("sourceOpinionId", "")).strip()
        question = card.get("question")
        answer = card.get("answer")
        selectors = card.get("evidenceSelectors")
        source_url = card.get("sourceUrl")
        if not opinion_id or not isinstance(question, str) or not question.strip() or not isinstance(answer, str) or not answer.strip():
            raise ValueError(f"reviewed cards line {line_number} needs sourceOpinionId, question, and answer")
        if not isinstance(selectors, list) or not all(isinstance(item, str) and item.strip() for item in selectors) or len(selectors) < 2:
            raise ValueError(f"reviewed cards line {line_number} needs at least two evidenceSelectors")
        if not isinstance(source_url, str) or not source_url.startswith("https://"):
            raise ValueError(f"reviewed cards line {line_number} needs an HTTPS sourceUrl")
        if opinion_id in cards:
            raise ValueError(f"duplicate sourceOpinionId in reviewed cards: {opinion_id}")
        cards[opinion_id] = card
    return cards


def build_runtime_pack(
    opinions_path: Path,
    clusters_path: Path | None,
    cards_path: Path,
    output_path: Path,
    manifest_path: Path,
    source_url: str,
    limit: int,
) -> dict[str, Any]:
    cards = read_reviewed_cards(cards_path)
    clusters: dict[str, dict[str, str]] = {}
    if clusters_path:
        for row in read_csv_rows(clusters_path):
            cluster_id = text(row, "id")
            if cluster_id:
                clusters[cluster_id] = row

    records: list[dict[str, Any]] = []
    unmatched = set(cards)
    for opinion in read_csv_rows(opinions_path):
        opinion_id = text(opinion, "id")
        card = cards.get(opinion_id)
        if not card:
            continue
        cluster = clusters.get(text(opinion, "cluster_id", "cluster"), {})
        body = normalize_body(text(opinion, "html_with_citations", "html", "html_lawbox", "html_columbia", "plain_text"))
        if len(body) < 300:
            raise ValueError(f"opinion {opinion_id} has no usable text field")
        document_id = f"courtlistener-opinion-{opinion_id}"
        chunks = make_evidence_chunks(body, [str(value).strip() for value in card["evidenceSelectors"]], document_id)
        title = text(cluster, "case_name", "case_name_full", "caseName") or text(opinion, "case_name", "case_name_full") or f"CourtListener opinion {opinion_id}"
        decided_at = text(cluster, "date_filed", "dateFiled") or text(opinion, "date_created", "date_modified") or "unknown"
        citation = text(cluster, "citation", "neutral_cite", "neutralCite") or text(opinion, "citation") or f"CourtListener opinion {opinion_id}"
        docket = text(cluster, "docket_number", "docketNumber", "docket_id") or "not listed"
        records.append({
            "kind": "evaluation_card",
            "documentId": document_id,
            "title": title,
            "docket": docket,
            "decidedAt": decided_at,
            "citation": citation,
            "sourceUrl": card["sourceUrl"],
            "question": card["question"].strip(),
            "answer": card["answer"].strip(),
            "chunks": chunks,
        })
        unmatched.discard(opinion_id)
        if len(records) >= limit:
            break

    expected_records = min(limit, len(cards))
    if len(records) < expected_records and unmatched:
        missing = ", ".join(sorted(unmatched)[:8])
        raise ValueError(f"reviewed sourceOpinionId values were not found in the opinions CSV: {missing}")
    if len(records) < 2:
        raise ValueError("at least two reviewed cards are required to create a PACT legal runtime pack")

    manifest = {
        "kind": "manifest",
        "schemaVersion": 1,
        "corpusId": "courtlistener-reviewed-evidence-v1",
        "source": {
            "provider": "Free Law Project / CourtListener bulk data",
            "sourceUrl": source_url,
            "retrievedAt": datetime.now(timezone.utc).isoformat(),
            "rights": DEFAULT_RIGHTS,
        },
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="\n") as target:
        target.write(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + "\n")
        for record in records:
            target.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")

    pack_bytes = output_path.read_bytes()
    audit = {
        "schemaVersion": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "rawSources": {
            "opinions": str(opinions_path),
            "opinionsSha256": hashlib.sha256(opinions_path.read_bytes()).hexdigest(),
            "clusters": str(clusters_path) if clusters_path else None,
            "clustersSha256": hashlib.sha256(clusters_path.read_bytes()).hexdigest() if clusters_path else None,
            "reviewedCards": str(cards_path),
            "reviewedCardsSha256": hashlib.sha256(cards_path.read_bytes()).hexdigest(),
        },
        "runtimePack": {
            "path": str(output_path),
            "sha256": hashlib.sha256(pack_bytes).hexdigest(),
            "bytes": len(pack_bytes),
            "reviewedDocuments": len(records),
            "evidenceChunks": sum(len(record["chunks"]) for record in records),
        },
        "policy": {
            "rawArchiveIsNotBundled": True,
            "reviewedEvidenceRequired": True,
            "primarySourceUrlRequired": True,
            "perAttemptDossier": True,
        },
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return audit


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--opinions", type=Path, required=True, help="CourtListener opinions bulk CSV")
    parser.add_argument("--clusters", type=Path, help="CourtListener opinion clusters bulk CSV")
    parser.add_argument("--reviewed-cards", type=Path, required=True, help="Reviewer-approved JSONL question cards")
    parser.add_argument("--output", type=Path, required=True, help="Output PACT runtime JSONL pack")
    parser.add_argument("--manifest", type=Path, required=True, help="Output audit manifest JSON")
    parser.add_argument("--source-url", default=DEFAULT_SOURCE_URL, help="Provenance URL for the bulk retrieval")
    parser.add_argument("--limit", type=int, default=5_000, help="Maximum reviewed documents to emit")
    args = parser.parse_args()
    if args.limit < 2 or args.limit > 50_000:
        parser.error("--limit must be between 2 and 50000")
    audit = build_runtime_pack(
        opinions_path=args.opinions,
        clusters_path=args.clusters,
        cards_path=args.reviewed_cards,
        output_path=args.output,
        manifest_path=args.manifest,
        source_url=args.source_url,
        limit=args.limit,
    )
    print(json.dumps(audit["runtimePack"], ensure_ascii=False))


if __name__ == "__main__":
    main()
