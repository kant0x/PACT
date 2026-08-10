import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const config = {
  apiUrl: process.env.PACT_PUBLIC_API_URL ?? 'https://api.arc.pact.kant0x.xyz',
  arcRpcUrl: process.env.PACT_PUBLIC_ARC_RPC_URL ?? 'https://rpc.testnet.arc.network',
  streamingVaultAddress: process.env.PACT_PUBLIC_STREAMING_VAULT_ADDRESS ?? '0x6eF50b267ae5A93a1750A8bB84a3F3d58d71Fc48',
  agentRegistryAddress: process.env.PACT_PUBLIC_AGENT_REGISTRY_ADDRESS ?? '',
  reputationRegistryAddress: process.env.PACT_PUBLIC_REPUTATION_REGISTRY_ADDRESS ?? '',
  workOrderCommitmentsAddress: process.env.PACT_PUBLIC_WORK_ORDER_COMMITMENTS_ADDRESS ?? '',
  verificationRegistryAddress: process.env.PACT_PUBLIC_VERIFICATION_REGISTRY_ADDRESS ?? '',
  hubRegistryAddress: process.env.PACT_PUBLIC_HUB_REGISTRY_ADDRESS ?? '',
  milestoneEscrowAddress: process.env.PACT_PUBLIC_MILESTONE_ESCROW_ADDRESS ?? '',
  subscriptionVaultAddress: process.env.PACT_PUBLIC_SUBSCRIPTION_VAULT_ADDRESS ?? '',
  rewardVaultAddress: process.env.PACT_PUBLIC_REWARD_VAULT_ADDRESS ?? '',
  usdcAddress: process.env.PACT_PUBLIC_USDC_ADDRESS ?? '0x3600000000000000000000000000000000000000',
};

if (!/^https?:\/\//i.test(config.apiUrl) || !/^https?:\/\//i.test(config.arcRpcUrl)) {
  throw new Error('PACT_PUBLIC_API_URL and PACT_PUBLIC_ARC_RPC_URL must be public http(s) URLs.');
}

for (const [name, address] of Object.entries({
  PACT_PUBLIC_STREAMING_VAULT_ADDRESS: config.streamingVaultAddress,
  PACT_PUBLIC_USDC_ADDRESS: config.usdcAddress,
})) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error(`${name} must be a public EVM address.`);
}

for (const [name, address] of Object.entries({
  PACT_PUBLIC_AGENT_REGISTRY_ADDRESS: config.agentRegistryAddress,
  PACT_PUBLIC_REPUTATION_REGISTRY_ADDRESS: config.reputationRegistryAddress,
  PACT_PUBLIC_WORK_ORDER_COMMITMENTS_ADDRESS: config.workOrderCommitmentsAddress,
  PACT_PUBLIC_VERIFICATION_REGISTRY_ADDRESS: config.verificationRegistryAddress,
  PACT_PUBLIC_HUB_REGISTRY_ADDRESS: config.hubRegistryAddress,
  PACT_PUBLIC_MILESTONE_ESCROW_ADDRESS: config.milestoneEscrowAddress,
  PACT_PUBLIC_SUBSCRIPTION_VAULT_ADDRESS: config.subscriptionVaultAddress,
  PACT_PUBLIC_REWARD_VAULT_ADDRESS: config.rewardVaultAddress,
})) {
  if (address && !/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error(`${name} must be a public EVM address when configured.`);
}

const output = resolve('frontend/dist/pact-config.js');
await mkdir(resolve('frontend/dist'), { recursive: true });
await writeFile(output, `// Generated for a Cloudflare Pages static upload. Contains public endpoints only.\nwindow.__PACT_CONFIG__ = ${JSON.stringify(config, null, 2)};\n`, 'utf8');
console.log(`Wrote public Pages runtime configuration: ${output}`);
