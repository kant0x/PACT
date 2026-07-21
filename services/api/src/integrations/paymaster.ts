import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USDC_DECIMALS = 6;

export type SponsoredOperation =
  | {
      kind: 'createTask';
      agentAddress: string;
      totalAmountUsdc: string;
      requiredCollateralPct: number;
    }
  | {
      kind: 'postCollateral';
      taskId: string;
      collateralAmountUsdc: string;
    };

export interface CirclePaymasterConfig {
  enabled: true;
  apiKey: string;
  entitySecret: string;
  chain: 'ARC-TESTNET';
  vaultAddress: string;
  allowedChains: ReadonlySet<string>;
  allowedContracts: ReadonlySet<string>;
  allowedWalletIds: ReadonlySet<string>;
  maxOperationAmountAtomic: bigint;
  maxOperationAmountUsdc: string;
  feeLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  databasePath: string;
}

export interface SponsorshipRecord {
  walletKey: string;
  walletId: string;
  walletAddress: string;
  chain: string;
  operation: SponsoredOperation['kind'];
  requestHash: string;
  idempotencyKey: string;
}

export interface SponsorshipLedger {
  reserve(record: SponsorshipRecord): boolean;
  markSubmitted(walletKey: string, transactionId: string): void;
  markFailedClosed(walletKey: string, reason: string): void;
}

export class PaymasterPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymasterPolicyError';
  }
}

const required = (env: NodeJS.ProcessEnv, name: string) => {
  const value = env[name]?.trim();
  if (!value) throw new PaymasterPolicyError(`${name} is required`);
  return value;
};

const csv = (value: string) => new Set(value.split(',').map((part) => part.trim()).filter(Boolean));
const normalizedAddresses = (values: ReadonlySet<string>) => new Set([...values].map((value) => value.toLowerCase()));

export function toUsdcAtomic(value: string): bigint {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match) throw new PaymasterPolicyError('USDC amount must be a positive decimal with at most 6 decimal places');
  const atomic = BigInt(match[1]) * 10n ** BigInt(USDC_DECIMALS)
    + BigInt((match[2] ?? '').padEnd(USDC_DECIMALS, '0') || '0');
  if (atomic <= 0n) throw new PaymasterPolicyError('USDC amount must be greater than zero');
  return atomic;
}

export function readCirclePaymasterConfig(env: NodeJS.ProcessEnv = process.env): CirclePaymasterConfig {
  if (env.CIRCLE_PAYMASTER_ENABLED !== 'true') {
    throw new PaymasterPolicyError('CIRCLE_PAYMASTER_ENABLED=true is required; sponsorship is fail-closed by default');
  }
  if (env.CIRCLE_GAS_STATION_POLICY_CONFIRMED !== 'true') {
    throw new PaymasterPolicyError('CIRCLE_GAS_STATION_POLICY_CONFIRMED=true is required after verifying the Circle Console policy');
  }

  const chain = required(env, 'CIRCLE_PAYMASTER_CHAIN').toUpperCase();
  if (chain !== 'ARC-TESTNET') throw new PaymasterPolicyError('Only ARC-TESTNET is supported by this PACT adapter');
  const allowedChains = new Set([...csv(required(env, 'CIRCLE_PAYMASTER_ALLOWED_CHAINS'))].map((item) => item.toUpperCase()));
  if (!allowedChains.has(chain)) throw new PaymasterPolicyError(`${chain} is not in CIRCLE_PAYMASTER_ALLOWED_CHAINS`);

  const vaultAddress = required(env, 'STREAMING_VAULT_ADDRESS');
  if (!ADDRESS.test(vaultAddress)) throw new PaymasterPolicyError('STREAMING_VAULT_ADDRESS must be a valid EVM address');
  const allowedContracts = normalizedAddresses(csv(required(env, 'CIRCLE_PAYMASTER_ALLOWED_CONTRACTS')));
  if (!allowedContracts.has(vaultAddress.toLowerCase())) {
    throw new PaymasterPolicyError('STREAMING_VAULT_ADDRESS must be explicitly included in CIRCLE_PAYMASTER_ALLOWED_CONTRACTS');
  }

  const allowedWalletIds = csv(required(env, 'CIRCLE_PAYMASTER_ALLOWED_WALLET_IDS'));
  if ([...allowedWalletIds].some((id) => !UUID.test(id))) {
    throw new PaymasterPolicyError('CIRCLE_PAYMASTER_ALLOWED_WALLET_IDS must contain Circle wallet UUIDs');
  }

  const maxOperationAmountUsdc = required(env, 'CIRCLE_PAYMASTER_MAX_OPERATION_USDC');
  const feeLevel = (env.CIRCLE_PAYMASTER_FEE_LEVEL ?? 'MEDIUM').toUpperCase();
  if (!['LOW', 'MEDIUM', 'HIGH'].includes(feeLevel)) {
    throw new PaymasterPolicyError('CIRCLE_PAYMASTER_FEE_LEVEL must be LOW, MEDIUM, or HIGH');
  }

  return {
    enabled: true,
    apiKey: required(env, 'CIRCLE_API_KEY'),
    entitySecret: required(env, 'CIRCLE_ENTITY_SECRET'),
    chain,
    vaultAddress,
    allowedChains,
    allowedContracts,
    allowedWalletIds,
    maxOperationAmountAtomic: toUsdcAtomic(maxOperationAmountUsdc),
    maxOperationAmountUsdc,
    feeLevel: feeLevel as CirclePaymasterConfig['feeLevel'],
    databasePath: env.CIRCLE_PAYMASTER_DB_PATH?.trim() || 'data/paymaster.sqlite'
  };
}

export class MemorySponsorshipLedger implements SponsorshipLedger {
  readonly records = new Map<string, SponsorshipRecord & { status: string; transactionId?: string; reason?: string }>();

  reserve(record: SponsorshipRecord) {
    if (this.records.has(record.walletKey)) return false;
    this.records.set(record.walletKey, { ...record, status: 'RESERVED' });
    return true;
  }

  markSubmitted(walletKey: string, transactionId: string) {
    const record = this.records.get(walletKey);
    if (record) this.records.set(walletKey, { ...record, status: 'SUBMITTED', transactionId });
  }

  markFailedClosed(walletKey: string, reason: string) {
    const record = this.records.get(walletKey);
    if (record) this.records.set(walletKey, { ...record, status: 'FAILED_CLOSED', reason });
  }
}

export class SqliteSponsorshipLedger implements SponsorshipLedger {
  readonly path: string;
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true });
    this.database = new DatabaseSync(this.path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS circle_sponsorship (
        wallet_key TEXT PRIMARY KEY,
        wallet_id TEXT NOT NULL,
        wallet_address TEXT NOT NULL,
        chain TEXT NOT NULL,
        operation TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        transaction_id TEXT,
        failure_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  reserve(record: SponsorshipRecord) {
    const now = Date.now();
    const result = this.database.prepare(`
      INSERT INTO circle_sponsorship (
        wallet_key, wallet_id, wallet_address, chain, operation, request_hash,
        idempotency_key, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'RESERVED', ?, ?)
      ON CONFLICT(wallet_key) DO NOTHING
    `).run(
      record.walletKey,
      record.walletId,
      record.walletAddress,
      record.chain,
      record.operation,
      record.requestHash,
      record.idempotencyKey,
      now,
      now
    );
    return result.changes === 1;
  }

  markSubmitted(walletKey: string, transactionId: string) {
    this.database.prepare(`
      UPDATE circle_sponsorship
      SET status = 'SUBMITTED', transaction_id = ?, updated_at = ?
      WHERE wallet_key = ?
    `).run(transactionId, Date.now(), walletKey);
  }

  markFailedClosed(walletKey: string, reason: string) {
    this.database.prepare(`
      UPDATE circle_sponsorship
      SET status = 'FAILED_CLOSED', failure_reason = ?, updated_at = ?
      WHERE wallet_key = ?
    `).run(reason.slice(0, 500), Date.now(), walletKey);
  }

  close() {
    this.database.close();
  }
}

interface CircleWalletView {
  id: string;
  address: string;
  blockchain: string;
  state: string;
}

interface CircleTransactionView {
  sourceAddress?: string;
}

export interface PaymasterCircleClient {
  getWallet(input: { id: string }): Promise<{ data?: { wallet?: CircleWalletView } }>;
  listTransactions(input: { walletIds: string[]; includeAll: boolean }): Promise<{ data?: { transactions?: CircleTransactionView[] } }>;
  createContractExecutionTransaction(input: {
    walletId: string;
    contractAddress: string;
    abiFunctionSignature: string;
    abiParameters: Array<string | number>;
    refId: string;
    idempotencyKey: string;
    fee: { type: 'level'; config: { feeLevel: 'LOW' | 'MEDIUM' | 'HIGH' } };
  }): Promise<{ data?: { id?: string; state?: string } }>;
}

function operationCall(operation: SponsoredOperation, config: CirclePaymasterConfig) {
  const amount = operation.kind === 'createTask' ? operation.totalAmountUsdc : operation.collateralAmountUsdc;
  const amountAtomic = toUsdcAtomic(amount);
  if (amountAtomic > config.maxOperationAmountAtomic) {
    throw new PaymasterPolicyError(`Operation amount exceeds the ${config.maxOperationAmountUsdc} USDC sponsorship policy cap`);
  }

  if (operation.kind === 'createTask') {
    if (!ADDRESS.test(operation.agentAddress)) throw new PaymasterPolicyError('agentAddress must be a valid EVM address');
    if (!Number.isInteger(operation.requiredCollateralPct)
      || operation.requiredCollateralPct < 0
      || operation.requiredCollateralPct > 100) {
      throw new PaymasterPolicyError('requiredCollateralPct must be an integer from 0 to 100');
    }
    return {
      abiFunctionSignature: 'createTask(address,uint256,uint256)',
      abiParameters: [operation.agentAddress, amountAtomic.toString(), operation.requiredCollateralPct]
    };
  }

  if (!/^[1-9]\d*$/.test(operation.taskId)) throw new PaymasterPolicyError('taskId must be a positive integer');
  return {
    abiFunctionSignature: 'postCollateral(uint256)',
    abiParameters: [operation.taskId]
  };
}

export class CirclePaymasterAdapter {
  constructor(
    private readonly client: PaymasterCircleClient,
    private readonly config: CirclePaymasterConfig,
    private readonly ledger: SponsorshipLedger
  ) {}

  async sponsorFirstOperation(walletId: string, operation: SponsoredOperation) {
    if (!this.config.allowedWalletIds.has(walletId)) {
      throw new PaymasterPolicyError('Wallet is not in CIRCLE_PAYMASTER_ALLOWED_WALLET_IDS');
    }
    if (!this.config.allowedChains.has(this.config.chain)) {
      throw new PaymasterPolicyError('Configured chain is not allowlisted');
    }
    if (!this.config.allowedContracts.has(this.config.vaultAddress.toLowerCase())) {
      throw new PaymasterPolicyError('StreamingVault is not allowlisted');
    }

    const call = operationCall(operation, this.config);
    const walletResponse = await this.client.getWallet({ id: walletId });
    const wallet = walletResponse.data?.wallet;
    if (!wallet) throw new PaymasterPolicyError('Circle did not return the requested wallet');
    if (wallet.id !== walletId) throw new PaymasterPolicyError('Circle wallet ID mismatch');
    if (wallet.blockchain.toUpperCase() !== this.config.chain) throw new PaymasterPolicyError('Wallet chain is not allowlisted');
    if (wallet.state !== 'LIVE') throw new PaymasterPolicyError('Circle wallet must be LIVE');
    if (!ADDRESS.test(wallet.address)) throw new PaymasterPolicyError('Circle returned an invalid wallet address');

    const transactions = await this.client.listTransactions({ walletIds: [walletId], includeAll: true });
    const hasOutboundTransaction = (transactions.data?.transactions ?? []).some(
      (transaction) => transaction.sourceAddress?.toLowerCase() === wallet.address.toLowerCase()
    );
    if (hasOutboundTransaction) throw new PaymasterPolicyError('Only the first outbound transaction can be sponsored');

    const idempotencyKey = randomUUID();
    const requestHash = `sha256:${createHash('sha256').update(JSON.stringify({
      chain: this.config.chain,
      walletId,
      walletAddress: wallet.address.toLowerCase(),
      vaultAddress: this.config.vaultAddress.toLowerCase(),
      operation
    })).digest('hex')}`;
    const walletKey = `${this.config.chain}:${walletId}`;
    const reserved = this.ledger.reserve({
      walletKey,
      walletId,
      walletAddress: wallet.address.toLowerCase(),
      chain: this.config.chain,
      operation: operation.kind,
      requestHash,
      idempotencyKey
    });
    if (!reserved) throw new PaymasterPolicyError('Sponsorship was already reserved or submitted for this wallet');

    try {
      const response = await this.client.createContractExecutionTransaction({
        walletId,
        contractAddress: this.config.vaultAddress,
        ...call,
        refId: `pact-first-${operation.kind}`,
        idempotencyKey,
        fee: { type: 'level', config: { feeLevel: this.config.feeLevel } }
      });
      const transactionId = response.data?.id;
      if (!transactionId) throw new Error('Circle did not return a transaction ID');
      this.ledger.markSubmitted(walletKey, transactionId);
      return {
        transactionId,
        state: response.data?.state ?? 'UNKNOWN',
        walletId,
        walletAddress: wallet.address,
        operation: operation.kind,
        requestHash,
        idempotencyKey
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Circle error';
      this.ledger.markFailedClosed(walletKey, message);
      throw new PaymasterPolicyError(
        `Circle submission failed after the one-time slot was reserved; reconcile idempotency key ${idempotencyKey} before any manual retry`
      );
    }
  }
}

export function createCirclePaymasterFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const config = readCirclePaymasterConfig(env);
  const client = initiateDeveloperControlledWalletsClient({
    apiKey: config.apiKey,
    entitySecret: config.entitySecret
  });
  const ledger = new SqliteSponsorshipLedger(config.databasePath);
  return {
    adapter: new CirclePaymasterAdapter(client as unknown as PaymasterCircleClient, config, ledger),
    ledger,
    config
  };
}
