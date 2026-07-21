import { describe, expect, it } from 'vitest';
import {
  CirclePaymasterAdapter,
  MemorySponsorshipLedger,
  PaymasterPolicyError,
  readCirclePaymasterConfig,
  type PaymasterCircleClient
} from '../src/integrations/paymaster.js';

const WALLET_ID = '11111111-1111-4111-8111-111111111111';
const WALLET_ADDRESS = '0x1111111111111111111111111111111111111111';
const VAULT = '0x2222222222222222222222222222222222222222';
const AGENT = '0x3333333333333333333333333333333333333333';

const env = () => ({
  CIRCLE_PAYMASTER_ENABLED: 'true',
  CIRCLE_GAS_STATION_POLICY_CONFIRMED: 'true',
  CIRCLE_API_KEY: 'test-api-key',
  CIRCLE_ENTITY_SECRET: 'test-entity-secret',
  CIRCLE_PAYMASTER_CHAIN: 'ARC-TESTNET',
  CIRCLE_PAYMASTER_ALLOWED_CHAINS: 'ARC-TESTNET',
  CIRCLE_PAYMASTER_ALLOWED_CONTRACTS: VAULT,
  CIRCLE_PAYMASTER_ALLOWED_WALLET_IDS: WALLET_ID,
  CIRCLE_PAYMASTER_MAX_OPERATION_USDC: '25',
  CIRCLE_PAYMASTER_FEE_LEVEL: 'MEDIUM',
  STREAMING_VAULT_ADDRESS: VAULT
});

function fakeClient(existingOutbound = false) {
  const calls: unknown[] = [];
  const client: PaymasterCircleClient = {
    async getWallet() {
      return { data: { wallet: { id: WALLET_ID, address: WALLET_ADDRESS, blockchain: 'ARC-TESTNET', state: 'LIVE' } } };
    },
    async listTransactions() {
      return { data: { transactions: existingOutbound ? [{ sourceAddress: WALLET_ADDRESS }] : [] } };
    },
    async createContractExecutionTransaction(input) {
      calls.push(input);
      return { data: { id: 'circle-transaction-1', state: 'INITIATED' } };
    }
  };
  return { client, calls };
}

describe('Circle Paymaster policy', () => {
  it('fails closed unless sponsorship and the Console policy are explicitly enabled', () => {
    expect(() => readCirclePaymasterConfig({ ...env(), CIRCLE_PAYMASTER_ENABLED: 'false' }))
      .toThrow(PaymasterPolicyError);
    expect(() => readCirclePaymasterConfig({ ...env(), CIRCLE_GAS_STATION_POLICY_CONFIRMED: 'false' }))
      .toThrow(/POLICY_CONFIRMED/);
  });

  it('allows only an allowlisted Arc wallet, contract, and bounded operation', async () => {
    const config = readCirclePaymasterConfig(env());
    const { client, calls } = fakeClient();
    const adapter = new CirclePaymasterAdapter(client, config, new MemorySponsorshipLedger());

    const result = await adapter.sponsorFirstOperation(WALLET_ID, {
      kind: 'createTask',
      agentAddress: AGENT,
      totalAmountUsdc: '24.5',
      requiredCollateralPct: 25
    });

    expect(result.transactionId).toBe('circle-transaction-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      contractAddress: VAULT,
      abiFunctionSignature: 'createTask(address,uint256,uint256)',
      abiParameters: [AGENT, '24500000', 25]
    });
  });

  it('enforces one sponsorship reservation per wallet even when Circle still reports no transaction', async () => {
    const config = readCirclePaymasterConfig(env());
    const { client, calls } = fakeClient();
    const adapter = new CirclePaymasterAdapter(client, config, new MemorySponsorshipLedger());
    const operation = { kind: 'postCollateral', taskId: '1', collateralAmountUsdc: '5' } as const;

    await adapter.sponsorFirstOperation(WALLET_ID, operation);
    await expect(adapter.sponsorFirstOperation(WALLET_ID, operation)).rejects.toThrow(/already reserved or submitted/);
    expect(calls).toHaveLength(1);
  });

  it('rejects overspend and wallets with an existing outbound transaction before submission', async () => {
    const config = readCirclePaymasterConfig(env());
    const first = fakeClient();
    const overspend = new CirclePaymasterAdapter(first.client, config, new MemorySponsorshipLedger());
    await expect(overspend.sponsorFirstOperation(WALLET_ID, {
      kind: 'createTask',
      agentAddress: AGENT,
      totalAmountUsdc: '25.000001',
      requiredCollateralPct: 25
    })).rejects.toThrow(/exceeds/);
    expect(first.calls).toHaveLength(0);

    const second = fakeClient(true);
    const usedWallet = new CirclePaymasterAdapter(second.client, config, new MemorySponsorshipLedger());
    await expect(usedWallet.sponsorFirstOperation(WALLET_ID, {
      kind: 'postCollateral',
      taskId: '1',
      collateralAmountUsdc: '5'
    })).rejects.toThrow(/first outbound/);
    expect(second.calls).toHaveLength(0);
  });

  it('keeps the one-time slot blocked when the Circle result is uncertain', async () => {
    const config = readCirclePaymasterConfig(env());
    const ledger = new MemorySponsorshipLedger();
    const { client } = fakeClient();
    client.createContractExecutionTransaction = async () => {
      throw new Error('upstream timeout');
    };
    const adapter = new CirclePaymasterAdapter(client, config, ledger);
    const operation = { kind: 'postCollateral', taskId: '1', collateralAmountUsdc: '5' } as const;

    await expect(adapter.sponsorFirstOperation(WALLET_ID, operation)).rejects.toThrow(/idempotency key/);
    await expect(adapter.sponsorFirstOperation(WALLET_ID, operation)).rejects.toThrow(/already reserved or submitted/);
    expect([...ledger.records.values()][0]?.status).toBe('FAILED_CLOSED');
  });
});
