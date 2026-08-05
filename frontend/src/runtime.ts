export interface PactRuntimeConfig {
  apiUrl?: string;
  arcRpcUrl?: string;
  streamingVaultAddress?: `0x${string}`;
  usdcAddress?: `0x${string}`;
}

const browserConfig = typeof window !== 'undefined'
  ? (window as Window & { __PACT_CONFIG__?: PactRuntimeConfig }).__PACT_CONFIG__
  : undefined;

export const runtimeConfig: PactRuntimeConfig = {
  apiUrl: browserConfig?.apiUrl ?? import.meta.env.VITE_API_URL,
  arcRpcUrl: browserConfig?.arcRpcUrl ?? import.meta.env.VITE_ARC_RPC_URL,
  streamingVaultAddress: browserConfig?.streamingVaultAddress ?? import.meta.env.VITE_STREAMING_VAULT_ADDRESS,
  usdcAddress: browserConfig?.usdcAddress ?? import.meta.env.VITE_USDC_ADDRESS,
};

export const isArcMode = true;
export const ARC_RPC_URL = runtimeConfig.arcRpcUrl ?? 'https://rpc.testnet.arc.network';
export const ARC_USDC_ADDRESS = runtimeConfig.usdcAddress ?? '0x3600000000000000000000000000000000000000';

export function requireStreamingVaultAddress(): `0x${string}` {
  const address = runtimeConfig.streamingVaultAddress;
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error('StreamingVault is not configured for this Arc Testnet deployment.');
  }
  return address;
}
