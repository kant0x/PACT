/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_API_TOKEN?: string;
  readonly VITE_PACT_MODE?: 'demo' | 'arc';
  readonly VITE_ARC_RPC_URL?: string;
  readonly VITE_STREAMING_VAULT_ADDRESS?: `0x${string}`;
  readonly VITE_USDC_ADDRESS?: `0x${string}`;
  readonly VITE_AUTO_SEED_DEMO?: 'true' | 'false';
  readonly VITE_REQUIRE_ARENA_SIGNATURES?: 'true' | 'false';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
