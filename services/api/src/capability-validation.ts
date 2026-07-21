import type { AgentCapability, AgentCapabilityManifest, AgentRuntimeBinding, AgentWalletPolicy } from '@pact/shared';
import { assert } from './errors.js';

const nonEmptyText = (value: unknown, field: string, max: number) => {
  assert(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max,
    400, 'INVALID_CAPABILITY_MANIFEST', `${field} must contain 1..${max} non-whitespace characters`);
  // Keep the original value after validation. The registration signature is
  // over the exact JSON payload, so silently trimming nested fields here would
  // make the persisted manifest differ from what the wallet approved.
  return value as string;
};

const boundedStringArray = (value: unknown, field: string, min: number, max: number, itemMax = 120) => {
  assert(Array.isArray(value) && value.length >= min && value.length <= max && value.every((item) =>
    typeof item === 'string' && item.trim().length > 0 && item.trim().length <= itemMax),
  400, 'INVALID_CAPABILITY_MANIFEST', `${field} must contain ${min}..${max} bounded strings`);
  return value.map((item) => item as string);
};

/**
 * Validate and normalize the manifest at the API boundary. The wallet signs
 * the canonical, validated fields (with server-assigned `updatedAt` omitted),
 * so the persisted representation remains verifiable.
 */
export function validateCapabilityManifest(input: unknown): AgentCapabilityManifest {
  assert(input && typeof input === 'object' && !Array.isArray(input),
    400, 'INVALID_CAPABILITY_MANIFEST', 'A capability manifest is required');
  const candidate = input as Record<string, unknown>;
  assert(candidate.executionMode === 'EXTERNAL_RUNTIME', 400, 'INVALID_EXECUTION_MODE', 'executionMode must be EXTERNAL_RUNTIME');

  const capabilitiesInput = candidate.capabilities;
  assert(Array.isArray(capabilitiesInput) && capabilitiesInput.length > 0 && capabilitiesInput.length <= 16,
    400, 'INVALID_CAPABILITIES', 'capabilities must contain 1..16 declarations');
  const capabilities: AgentCapability[] = capabilitiesInput.map((raw, index) => {
    assert(raw && typeof raw === 'object' && !Array.isArray(raw),
      400, 'INVALID_CAPABILITY', `capabilities[${index}] must be an object`);
    const capability = raw as Record<string, unknown>;
    assert(['SELF_DECLARED', 'DEMO_VERIFIED', 'EXTERNAL_ATTESTATION'].includes(String(capability.verification)),
      400, 'INVALID_CAPABILITY', `capabilities[${index}].verification is not recognized`);
    return {
      id: nonEmptyText(capability.id, `capabilities[${index}].id`, 64),
      label: nonEmptyText(capability.label, `capabilities[${index}].label`, 80),
      description: nonEmptyText(capability.description, `capabilities[${index}].description`, 500),
      inputTypes: boundedStringArray(capability.inputTypes, `capabilities[${index}].inputTypes`, 0, 16),
      outputTypes: boundedStringArray(capability.outputTypes, `capabilities[${index}].outputTypes`, 0, 16),
      verification: capability.verification as AgentCapability['verification']
    };
  });
  assert(new Set(capabilities.map((capability) => capability.id.toLowerCase())).size === capabilities.length,
    400, 'INVALID_CAPABILITIES', 'capability ids must be unique within a manifest');

  const maxConcurrentTasks = candidate.maxConcurrentTasks;
  assert(Number.isInteger(maxConcurrentTasks) && Number(maxConcurrentTasks) >= 1 && Number(maxConcurrentTasks) <= 32,
    400, 'INVALID_CONCURRENCY', 'maxConcurrentTasks must be an integer from 1 to 32');

  const walletRaw = candidate.walletPolicy;
  assert(walletRaw && typeof walletRaw === 'object' && !Array.isArray(walletRaw),
    400, 'INVALID_WALLET_POLICY', 'walletPolicy is required');
  const wallet = walletRaw as Record<string, unknown>;
  const allowedChains = boundedStringArray(wallet.allowedChains, 'walletPolicy.allowedChains', 1, 16, 80);
  const allowedActions = boundedStringArray(wallet.allowedActions, 'walletPolicy.allowedActions', 1, 32, 80);
  const perTaskLimit = nonEmptyText(wallet.perTaskLimitUsdc, 'walletPolicy.perTaskLimitUsdc', 40);
  const parsedLimit = Number(perTaskLimit);
  assert(Number.isFinite(parsedLimit) && parsedLimit > 0 && parsedLimit <= 1_000_000_000,
    400, 'INVALID_WALLET_POLICY', 'walletPolicy.perTaskLimitUsdc must be a positive finite amount');
  const approval = wallet.requiresHumanApprovalAboveUsdc;
  assert(approval === null || approval === undefined || (typeof approval === 'string' && Number.isFinite(Number(approval)) && Number(approval) > 0),
    400, 'INVALID_WALLET_POLICY', 'walletPolicy.requiresHumanApprovalAboveUsdc must be null or a positive amount');

  const version = nonEmptyText(candidate.version, 'version', 32);
  let runtime: AgentRuntimeBinding | undefined;
  if (candidate.runtime !== undefined) {
    assert(candidate.runtime && typeof candidate.runtime === 'object' && !Array.isArray(candidate.runtime),
      400, 'INVALID_RUNTIME_BINDING', 'runtime must be an object');
    const runtimeCandidate = candidate.runtime as Record<string, unknown>;
    assert(runtimeCandidate.kind === 'OPENCLAW_GATEWAY' || runtimeCandidate.kind === 'EXTERNAL_API',
      400, 'INVALID_RUNTIME_BINDING', 'runtime.kind is not recognized');
    const gatewayUrl = runtimeCandidate.gatewayUrl;
    assert(gatewayUrl === null || gatewayUrl === undefined || (typeof gatewayUrl === 'string' && gatewayUrl.length <= 2048 && /^https?:\/\//i.test(gatewayUrl)),
      400, 'INVALID_RUNTIME_BINDING', 'runtime.gatewayUrl must be an http(s) URL or null');
    assert(runtimeCandidate.paymentRail === 'PACT_ESCROW' || runtimeCandidate.paymentRail === 'X402_METERED',
      400, 'INVALID_RUNTIME_BINDING', 'runtime.paymentRail is not recognized');
    assert(typeof runtimeCandidate.sandboxRequired === 'boolean',
      400, 'INVALID_RUNTIME_BINDING', 'runtime.sandboxRequired must be boolean');
    runtime = {
      kind: runtimeCandidate.kind,
      gatewayUrl: gatewayUrl === undefined ? null : gatewayUrl as string | null,
      paymentRail: runtimeCandidate.paymentRail,
      sandboxRequired: runtimeCandidate.sandboxRequired
    };
  }
  const manifest: AgentCapabilityManifest = {
    version,
    executionMode: 'EXTERNAL_RUNTIME',
    capabilities,
    tools: boundedStringArray(candidate.tools, 'tools', 0, 24),
    evidenceMethods: boundedStringArray(candidate.evidenceMethods, 'evidenceMethods', 1, 16),
    maxConcurrentTasks: Number(maxConcurrentTasks),
    walletPolicy: {
      allowedChains,
      allowedActions,
      perTaskLimitUsdc: perTaskLimit,
      requiresHumanApprovalAboveUsdc: approval === undefined ? null : approval as string | null
    } satisfies AgentWalletPolicy,
    ...(runtime ? { runtime } : {}),
    updatedAt: Math.floor(Date.now() / 1000)
  };
  return structuredClone(manifest);
}

export function defaultExternalManifest(): AgentCapabilityManifest {
  return {
    version: '1.0',
    executionMode: 'EXTERNAL_RUNTIME',
    capabilities: [{
      id: 'general.bounded-work',
      label: 'Bounded task execution',
      description: 'Accepts a scoped task and returns a reviewable, evidence-backed result.',
      inputTypes: ['task brief', 'acceptance criteria'],
      outputTypes: ['report', 'evidence manifest'],
      verification: 'SELF_DECLARED'
    }],
    tools: [],
    evidenceMethods: ['creator review'],
    maxConcurrentTasks: 1,
    walletPolicy: {
      allowedChains: ['ARC-TESTNET'],
      allowedActions: ['CLAIM_TASK'],
      perTaskLimitUsdc: '1',
      requiresHumanApprovalAboveUsdc: null
    },
    updatedAt: Math.floor(Date.now() / 1000)
  };
}
