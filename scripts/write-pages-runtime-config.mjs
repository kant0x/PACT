import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const config = {
  apiUrl: process.env.PACT_PUBLIC_API_URL ?? 'https://api.arc.pact.kant0x.xyz',
  arcRpcUrl: process.env.PACT_PUBLIC_ARC_RPC_URL ?? 'https://rpc.testnet.arc.network',
  streamingVaultAddress: process.env.PACT_PUBLIC_STREAMING_VAULT_ADDRESS ?? '0x6eF50b267ae5A93a1750A8bB84a3F3d58d71Fc48',
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

const output = resolve('frontend/dist/pact-config.js');
await mkdir(resolve('frontend/dist'), { recursive: true });
await writeFile(output, `// Generated for a Cloudflare Pages static upload. Contains public endpoints only.\nwindow.__PACT_CONFIG__ = ${JSON.stringify(config, null, 2)};\n`, 'utf8');
console.log(`Wrote public Pages runtime configuration: ${output}`);
