/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_ARC_RPC_URL?: string;
  readonly VITE_STREAMING_VAULT_ADDRESS?: `0x${string}`;
  readonly VITE_AGENT_REGISTRY_ADDRESS?: `0x${string}`;
  readonly VITE_MILESTONE_ESCROW_ADDRESS?: `0x${string}`;
  readonly VITE_SUBSCRIPTION_VAULT_ADDRESS?: `0x${string}`;
  readonly VITE_REWARD_VAULT_ADDRESS?: `0x${string}`;
  readonly VITE_USDC_ADDRESS?: `0x${string}`;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
