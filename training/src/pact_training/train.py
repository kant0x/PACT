from __future__ import annotations

import json
import platform
import tomllib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .common import read_json, sha256_text, write_json


def load_config(path: Path) -> dict[str, Any]:
    with path.open("rb") as handle:
        return tomllib.load(handle)


def check_dataset_gate(config: dict[str, Any], allow_small_dataset: bool = False) -> dict[str, Any]:
    data = config["data"]
    quality = config["quality"]
    manifest = read_json(Path(data["manifest_file"]))
    train_count = int(manifest["counts"]["train"])
    minimum = int(quality["minimum_train_examples"])
    if train_count < minimum and not allow_small_dataset:
        raise ValueError(
            f"Dataset has {train_count} training examples; at least {minimum} are required. "
            "Use --allow-small-dataset only for a smoke test, never for a release model."
        )
    if quality.get("require_first_party_license") and manifest.get("source") != "PACT_FIRST_PARTY":
        raise ValueError("Dataset provenance gate rejected a non-first-party manifest")
    return manifest


def run_training(config_path: Path, allow_small_dataset: bool = False, resume: str | None = None) -> Path:
    config = load_config(config_path)
    dataset_manifest = check_dataset_gate(config, allow_small_dataset)

    import torch
    from datasets import load_dataset
    from peft import LoraConfig, prepare_model_for_kbit_training
    from transformers import AutoModelForImageTextToText, AutoProcessor, BitsAndBytesConfig
    from trl import SFTConfig, SFTTrainer

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is required for the PACT QLoRA profile")
    model_cfg = config["model"]
    lora_cfg = config["lora"]
    train_cfg = config["training"]
    data_cfg = config["data"]
    dtype = torch.float16 if model_cfg["compute_dtype"] == "float16" else torch.bfloat16
    quantization = BitsAndBytesConfig(
        load_in_4bit=bool(model_cfg["load_in_4bit"]),
        bnb_4bit_quant_type=model_cfg["quant_type"],
        bnb_4bit_use_double_quant=bool(model_cfg["double_quant"]),
        bnb_4bit_compute_dtype=dtype,
    )
    processor = AutoProcessor.from_pretrained(model_cfg["id"], trust_remote_code=model_cfg["trust_remote_code"])
    model = AutoModelForImageTextToText.from_pretrained(
        model_cfg["id"],
        quantization_config=quantization,
        device_map="auto",
        dtype=dtype,
        trust_remote_code=model_cfg["trust_remote_code"],
    )
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=train_cfg["gradient_checkpointing"])
    adapter = LoraConfig(
        r=int(lora_cfg["rank"]),
        lora_alpha=int(lora_cfg["alpha"]),
        lora_dropout=float(lora_cfg["dropout"]),
        target_modules=lora_cfg["target_modules"],
        bias="none",
        task_type="CAUSAL_LM",
    )
    dataset = load_dataset("json", data_files={"train": data_cfg["train_file"], "eval": data_cfg["eval_file"]})
    arguments = SFTConfig(
        output_dir=train_cfg["output_dir"],
        num_train_epochs=float(train_cfg["epochs"]),
        learning_rate=float(train_cfg["learning_rate"]),
        per_device_train_batch_size=int(train_cfg["batch_size"]),
        per_device_eval_batch_size=1,
        gradient_accumulation_steps=int(train_cfg["gradient_accumulation_steps"]),
        warmup_ratio=float(train_cfg["warmup_ratio"]),
        max_length=int(train_cfg["max_length"]),
        assistant_only_loss=bool(train_cfg["assistant_only_loss"]),
        gradient_checkpointing=bool(train_cfg["gradient_checkpointing"]),
        fp16=dtype == torch.float16,
        bf16=dtype == torch.bfloat16,
        optim=train_cfg["optimizer"],
        logging_steps=int(train_cfg["logging_steps"]),
        eval_strategy="steps",
        eval_steps=int(train_cfg["eval_steps"]),
        save_steps=int(train_cfg["save_steps"]),
        save_total_limit=2,
        load_best_model_at_end=True,
        metric_for_best_model="eval_loss",
        greater_is_better=False,
        report_to="none",
        seed=int(train_cfg["seed"]),
    )
    trainer = SFTTrainer(
        model=model,
        args=arguments,
        train_dataset=dataset["train"],
        eval_dataset=dataset["eval"],
        peft_config=adapter,
        processing_class=processor,
    )
    trainer.train(resume_from_checkpoint=resume)
    output_dir = Path(train_cfg["output_dir"])
    trainer.save_model(output_dir / "adapter")
    processor.save_pretrained(output_dir / "adapter")
    metrics = trainer.evaluate()
    release = {
        "schemaVersion": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "baseModel": model_cfg["id"],
        "method": "QLORA_SFT_ASSISTANT_ONLY",
        "adapter": {"rank": lora_cfg["rank"], "alpha": lora_cfg["alpha"], "targetModules": lora_cfg["target_modules"]},
        "dataset": dataset_manifest,
        "metrics": metrics,
        "hardware": {"gpu": torch.cuda.get_device_name(0), "python": platform.python_version()},
        "configHash": sha256_text(config_path.read_text(encoding="utf-8")),
    }
    write_json(output_dir / "training_manifest.json", release)
    (output_dir / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    return output_dir
