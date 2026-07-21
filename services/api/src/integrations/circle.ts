import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { GatewayClient } from '@circle-fin/x402-batching/client';

const required = (name: string, value = process.env[name]) => {
  if (!value) throw new Error(`${name} is required`);
  return value;
};

async function createArcWallet(accountType: 'EOA' | 'SCA') {
  const client = initiateDeveloperControlledWalletsClient({
    apiKey: required('CIRCLE_API_KEY'),
    entitySecret: required('CIRCLE_ENTITY_SECRET')
  });
  let walletSetId = process.env.CIRCLE_WALLET_SET_ID;
  if (!walletSetId) {
    const response = await client.createWalletSet({ name: process.env.CIRCLE_WALLET_SET_NAME ?? 'PACT Agent Wallets' });
    walletSetId = response.data?.walletSet?.id;
  }
  if (!walletSetId) throw new Error('Circle did not return a wallet set ID');
  const response = await client.createWallets({
    walletSetId,
    blockchains: ['ARC-TESTNET'],
    count: 1,
    accountType
  });
  const wallet = response.data?.wallets?.[0];
  if (!wallet) throw new Error('Circle did not return a wallet');
  return { walletSetId, wallet };
}

export function createArcDeveloperWallet() {
  return createArcWallet('EOA');
}

/** Creates the ERC-4337 smart-contract account required by Circle Gas Station. */
export function createArcSponsoredWallet() {
  return createArcWallet('SCA');
}

export function createArcGatewayClient() {
  const privateKey = required('GATEWAY_PRIVATE_KEY');
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('GATEWAY_PRIVATE_KEY must be a 32-byte 0x-prefixed key');
  return new GatewayClient({
    chain: 'arcTestnet',
    privateKey: privateKey as `0x${string}`,
    rpcUrl: process.env.ARC_RPC_URL || undefined
  });
}

export interface SpendingPolicy {
  address: string;
  chain: string;
  perTransaction: number;
  daily: number;
  weekly: number;
  monthly: number;
}

export function buildSpendingPolicyArgs(policy: SpendingPolicy) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(policy.address)) throw new Error('A valid EVM wallet address is required');
  if (policy.chain.toUpperCase().includes('TESTNET')) throw new Error('Circle Agent Wallet spending policies are mainnet-only');
  const limits = [policy.perTransaction, policy.daily, policy.weekly, policy.monthly];
  if (limits.some((value) => !Number.isFinite(value) || value <= 0)) throw new Error('All spending limits must be positive');
  if (!(policy.perTransaction <= policy.daily && policy.daily <= policy.weekly && policy.weekly <= policy.monthly)) {
    throw new Error('Limits must satisfy per-transaction <= daily <= weekly <= monthly');
  }
  return [
    'wallet', 'limit', 'set',
    '--address', policy.address,
    '--chain', policy.chain.toUpperCase(),
    '--policy-type', 'stablecoin',
    '--per-tx', String(policy.perTransaction),
    '--daily', String(policy.daily),
    '--weekly', String(policy.weekly),
    '--monthly', String(policy.monthly)
  ];
}
