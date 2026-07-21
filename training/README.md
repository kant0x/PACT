# PACT first-party agent model training

This package turns consented, successful PACT execution traces into a
reproducible domain fine-tune. It is inspired by distillation-style agent SFT,
but deliberately does not copy third-party Claude or GPT traces.

## What is trained

The first profile uses `Qwen/Qwen3.5-2B` with 4-bit NF4 QLoRA, assistant-only
supervised loss and visible task/tool trajectories. The target behavior is:

- check reputation and wallet-policy limits before acting;
- operate inside explicit acceptance criteria;
- produce verifiable deliverables and evidence;
- refuse rank manipulation, policy bypasses and secret exposure;
- understand PACT settlement and dispute boundaries.

This is not pretraining from scratch. The output is a compact LoRA adapter over
the base model.

## Data policy

Only traces satisfying all of these conditions are exported:

1. `consentToTraining=true`;
2. finalized `SUCCESS` outcome;
3. visible user/assistant/tool events only;
4. an operator review decision of `APPROVED`;
5. no private chain-of-thought;
6. no detected secrets;
7. deterministic de-duplication;
8. task-grouped train/eval split to prevent leakage.

The agent submits a trace while a task is active:

```text
POST /api/agents/:agentAddress/traces
```

Authorized training export:

```text
GET /api/training/traces
```

Generate diverse task briefs for first-party execution (not synthetic answers):

```powershell
$env:PYTHONPATH="training/src"
python -m pact_training.cli factory --count 200 --output training/data/factory/tasks.jsonl
```

Factory rows become eligible training examples only after a real run, successful
settlement, explicit consent and human trace approval.

## Local workflow

From the repository root:

```powershell
python -m venv training/.venv
training/.venv/Scripts/Activate.ps1
pip install -e training

pact-training doctor
pact-training export --output training/data/raw/traces.json
pact-training prepare --input training/data/raw/traces.json
pact-training gate
pact-training train
```

For a smoke test of the data path before 200 accepted traces exist:

```powershell
$env:PYTHONPATH="training/src"
python -m pact_training.cli prepare `
  --input training/examples/sample_traces.json `
  --output-dir training/data/prepared
python -m pact_training.cli gate --allow-small-dataset
```

Do not use `--allow-small-dataset` for a release model.

## Hardware profile

The default configuration targets the available GTX 1660 Super 6 GB:

- 2B base model;
- 4-bit NF4 weights with double quantization;
- LoRA rank 16 on all linear layers;
- batch size 1, accumulation 16;
- 2,048-token maximum sequence length;
- FP16 compute and gradient checkpointing.

Long traces must be summarized into visible decisions, actions and receipts for
this local profile. A 9B full-parameter run like the referenced experiment needs
substantially more GPU memory or rented training hardware.

## Release gate

The default release gate requires at least 200 accepted examples; 2,000+ diverse
first-party traces are recommended. A release should also beat the base model on
the policy eval set, show no regression on general instruction following, and
undergo human review of sampled outputs.

Training writes a `training_manifest.json` containing the base model, adapter
settings, dataset hashes, metrics, hardware and config hash. The adapter should
not be registered in PACT until that manifest and the evaluation report pass
review.
