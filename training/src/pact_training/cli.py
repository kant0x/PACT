from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import sys
from pathlib import Path

from .evaluate import score_responses
from .export import export_traces
from .factory import generate_task_suite
from .prepare import prepare_dataset
from .train import check_dataset_gate, load_config, run_training


def _doctor(config_path: Path) -> int:
    config = load_config(config_path)
    gpu = "unavailable"
    try:
        gpu = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
            text=True,
            timeout=5,
        ).strip()
    except (FileNotFoundError, subprocess.SubprocessError):
        pass
    report = {
        "python": platform.python_version(),
        "platform": platform.platform(),
        "gpu": gpu,
        "baseModel": config["model"]["id"],
        "trainingProfile": "4-bit NF4 QLoRA / assistant-only SFT",
        "hfTokenConfigured": bool(os.getenv("HF_TOKEN")),
        "datasetManifestPresent": Path(config["data"]["manifest_file"]).exists(),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="PACT first-party agent model training pipeline")
    sub = parser.add_subparsers(dest="command", required=True)

    doctor = sub.add_parser("doctor", help="Inspect local training prerequisites")
    doctor.add_argument("--config", type=Path, default=Path("training/configs/qwen35-2b-qlora.toml"))

    export = sub.add_parser("export", help="Export consented successful traces from the PACT API")
    export.add_argument("--api", default="http://127.0.0.1:4100")
    export.add_argument("--token", default=os.getenv("PACT_AUTH_TOKEN"))
    export.add_argument("--output", type=Path, default=Path("training/data/raw/traces.json"))

    prepare = sub.add_parser("prepare", help="Validate, deduplicate, split, and hash traces")
    prepare.add_argument("--input", type=Path, required=True)
    prepare.add_argument("--output-dir", type=Path, default=Path("training/data/prepared"))
    prepare.add_argument("--eval-ratio", type=float, default=0.15)
    prepare.add_argument("--seed", type=int, default=42)

    gate = sub.add_parser("gate", help="Apply the release dataset quality gate")
    gate.add_argument("--config", type=Path, default=Path("training/configs/qwen35-2b-qlora.toml"))
    gate.add_argument("--allow-small-dataset", action="store_true")

    train = sub.add_parser("train", help="Run 4-bit QLoRA supervised fine-tuning")
    train.add_argument("--config", type=Path, default=Path("training/configs/qwen35-2b-qlora.toml"))
    train.add_argument("--allow-small-dataset", action="store_true")
    train.add_argument("--resume")

    evaluate = sub.add_parser("score-eval", help="Score generated responses against policy gates")
    evaluate.add_argument("--eval-file", type=Path, default=Path("training/evals/pact_policy_eval.jsonl"))
    evaluate.add_argument("--responses", type=Path, required=True)
    evaluate.add_argument("--output", type=Path, default=Path("training/outputs/eval-report.json"))

    factory = sub.add_parser("factory", help="Generate diverse task briefs for first-party trace collection")
    factory.add_argument("--output", type=Path, default=Path("training/data/factory/tasks.jsonl"))
    factory.add_argument("--count", type=int, default=40)
    factory.add_argument("--seed", type=int, default=42)

    args = parser.parse_args(argv)
    if args.command == "doctor":
        return _doctor(args.config)
    if args.command == "export":
        print(json.dumps({"exported": export_traces(args.api, args.output, args.token), "output": str(args.output)}))
        return 0
    if args.command == "prepare":
        print(json.dumps(prepare_dataset(args.input, args.output_dir, args.eval_ratio, args.seed).__dict__, default=str))
        return 0
    if args.command == "gate":
        print(json.dumps(check_dataset_gate(load_config(args.config), args.allow_small_dataset), ensure_ascii=False, indent=2))
        return 0
    if args.command == "train":
        print(run_training(args.config, args.allow_small_dataset, args.resume))
        return 0
    if args.command == "score-eval":
        print(json.dumps(score_responses(args.eval_file, args.responses, args.output), ensure_ascii=False, indent=2))
        return 0
    if args.command == "factory":
        print(json.dumps(generate_task_suite(args.output, args.count, args.seed), ensure_ascii=False, indent=2))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
