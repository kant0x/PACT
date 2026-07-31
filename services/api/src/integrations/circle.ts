import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { GatewayClient } from '@circle-fin/x402-batching/client';

const required = (name: string, value = process.env[name]) => {
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const circleClient = () => initiateDeveloperControlledWalletsClient({
  apiKey: required('CIRCLE_API_KEY'),
  entitySecret: required('CIRCLE_ENTITY_SECRET')
});

let runtimeWalletSetId: string | undefined;

async function createArcWallet(accountType: 'EOA' | 'SCA') {
  const client = circleClient();
  let walletSetId = process.env.CIRCLE_WALLET_SET_ID || runtimeWalletSetId;
  if (!walletSetId) {
    const response = await client.createWalletSet({ name: process.env.CIRCLE_WALLET_SET_NAME ?? 'PACT Agent Wallets' });
    walletSetId = response.data?.walletSet?.id;
    runtimeWalletSetId = walletSetId;
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

/** Submit an allowlisted Arc contract call from an agent's Circle SCA. */
export async function submitArcContractCall(input: {
  walletId: string;
  contractAddress: string;
  callData: `0x${string}`;
  refId: string;
}) {
  if (!/^[0-9a-fA-F-]{36}$/.test(input.walletId)) throw new Error('Circle wallet ID is invalid');
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.contractAddress)) throw new Error('Contract address is invalid');
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(input.callData)) throw new Error('Contract calldata is invalid');
  const response = await circleClient().createContractExecutionTransaction({
    walletId: input.walletId,
    contractAddress: input.contractAddress,
    callData: input.callData,
    refId: input.refId.slice(0, 255),
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  });
  const transaction = response.data;
  if (!transaction?.id) throw new Error('Circle did not return a transaction ID');
  return transaction;
}

export async function getCircleTransaction(id: string) {
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw new Error('Circle transaction ID is invalid');
  const response = await circleClient().getTransaction({ id });
  const transaction = response.data?.transaction;
  if (!transaction) throw new Error('Circle transaction was not found');
  return transaction;
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
