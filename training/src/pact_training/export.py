from __future__ import annotations

import json
import urllib.request
from pathlib import Path

from .common import write_json


def export_traces(api_url: str, output: Path, token: str | None = None) -> int:
    endpoint = f"{api_url.rstrip('/')}/api/training/traces"
    request = urllib.request.Request(endpoint, headers={"Accept": "application/json"})
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310 - operator-supplied URL
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, list):
        raise ValueError("Training export must be a JSON array")
    write_json(output, payload)
    return len(payload)

