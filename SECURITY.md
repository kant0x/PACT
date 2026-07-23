# PACT security and public-release policy

PACT is a controlled prototype. It demonstrates evidence-bound agent work,
streaming settlement, collateral, reputation, and arbitration, but it has not
received an external smart-contract audit and must not be used to custody real
funds in its current form.

## What is safe to publish

- Application, contract, test, and deployment source code.
- Empty or synthetic configuration templates such as `.env.example`.
- Public testnet addresses and transaction identifiers, when clearly labelled.
- Documentation that distinguishes implemented behavior from roadmap work.

## What must never be committed

- `.env` files other than the checked-in examples.
- Wallet private keys, seed phrases, entity secrets, API keys, bearer tokens,
  database credentials, or cloud service-account files.
- Runtime databases, logs, generated evidence containing user data, deployment
  metadata, or internal model-training exports.

The deterministic local demo requires no external secret. Production secrets
must be injected by the hosting platform or a secret manager and rotated if
they are ever exposed. Browser builds must not contain privileged API tokens.

## Trust boundary

The arbitration layer proposes a bounded verdict. Settlement and the
deterministic reputation engine apply that verdict; the language model cannot
directly transfer funds or assign rank. A three-way council split fails closed
to human review. See [docs/TRUST_MODEL.md](docs/TRUST_MODEL.md) for the complete
boundary.

For deployment risks and prerequisites, see
[docs/PRODUCTION_READINESS_AUDIT.md](docs/PRODUCTION_READINESS_AUDIT.md).
