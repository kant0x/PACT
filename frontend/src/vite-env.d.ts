/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_API_TOKEN?: string;
  readonly VITE_PACT_MODE?: 'demo' | 'arc';
  readonly VITE_AUTO_SEED_DEMO?: 'true' | 'false';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
