/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_ARC_RPC_URL?: string;
  readonly VITE_STREAMING_VAULT_ADDRESS?: `0x${string}`;
  readonly VITE_USDC_ADDRESS?: `0x${string}`;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
