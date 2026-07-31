import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { ethers } from 'ethers';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const envFile = process.env.PACT_ENV_FILE || path.join(root, '.env');
if (fs.existsSync(envFile)) dotenv.config({ path: envFile });

const CHAIN_ID = 91_342n;
const RPC_URL = process.env.GIWA_RPC_URL || process.env.GIWA_SEPOLIA_RPC_URL || 'https://sepolia-rpc.giwa.io';
const PRIVATE_KEY = process.env.GIWA_DEPLOYER_PRIVATE_KEY;
const SETTLEMENT_TOKEN = process.env.GIWA_SETTLEMENT_TOKEN_ADDRESS?.trim();
const OPERATOR = process.env.GIWA_OPERATOR_ADDRESS?.trim();
const POINTS_AWARDER = process.env.PLATFORM_POINTS_AWARDER_ADDRESS?.trim();
const COLLATERAL_TIMEOUT = BigInt(process.env.COLLATERAL_TIMEOUT_SECONDS || '86400');
const OUTPUT = path.join(root, 'deployments.giwa-sepolia.json');

function artifact(name) {
  const filename = path.join(root, 'artifacts', `${name}.json`);
  if (!fs.existsSync(filename)) throw new Error(`Missing ${name} artifact. Run npm run build first.`);
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function validAddress(name, value) {
  if (value && !ethers.isAddress(value)) throw new Error(`${name} must be a valid EVM address`);
}

async function deploy(name, wallet, args = []) {
  const compiled = artifact(name);
  const factory = new ethers.ContractFactory(compiled.abi, compiled.bytecode, wallet);
  const contract = await factory.deploy(...args);
  const deployment = await contract.deploymentTransaction()?.wait();
  const address = await contract.getAddress();
  console.log(`${name}: ${address}`);
  return { contract, address, transactionHash: deployment?.hash ?? null };
}

async function waitAndCheck(label, transaction, check) {
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`${label} transaction failed`);
  if (!(await check())) throw new Error(`${label} configuration did not persist`);
  return receipt.hash;
}

async function main() {
  if (!PRIVATE_KEY || !/^0x[0-9a-fA-F]{64}$/.test(PRIVATE_KEY)) {
    throw new Error('GIWA_DEPLOYER_PRIVATE_KEY must be a 32-byte 0x-prefixed private key');
  }
  validAddress('GIWA_SETTLEMENT_TOKEN_ADDRESS', SETTLEMENT_TOKEN);
  validAddress('GIWA_OPERATOR_ADDRESS', OPERATOR);
  validAddress('PLATFORM_POINTS_AWARDER_ADDRESS', POINTS_AWARDER);
  if (COLLATERAL_TIMEOUT <= 0n) throw new Error('COLLATERAL_TIMEOUT_SECONDS must be positive');

  const provider = new ethers.JsonRpcProvider(RPC_URL, { chainId: Number(CHAIN_ID), name: 'giwa-sepolia' }, { staticNetwork: true });
  const network = await provider.getNetwork();
  if (network.chainId !== CHAIN_ID) throw new Error(`Wrong chain: expected ${CHAIN_ID}, received ${network.chainId}`);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const balance = await provider.getBalance(wallet.address);
  if (balance === 0n) throw new Error(`Deployment wallet ${wallet.address} has no GIWA Sepolia ETH for gas`);
  console.log(`Deploying PACT to GIWA Sepolia from ${wallet.address}`);

  let settlementTokenAddress = SETTLEMENT_TOKEN;
  let settlementTokenDeployment = null;
  if (settlementTokenAddress) {
    if (await provider.getCode(settlementTokenAddress) === '0x') {
      throw new Error(`No contract code at GIWA_SETTLEMENT_TOKEN_ADDRESS ${settlementTokenAddress}`);
    }
    console.log(`Settlement token: ${settlementTokenAddress}`);
  } else {
    const deployed = await deploy('MockUSDC', wallet);
    settlementTokenAddress = deployed.address;
    settlementTokenDeployment = deployed.transactionHash;
    console.warn('Using freshly deployed test-only MockUSDC. Do not use it as a production asset.');
  }

  const dispute = await deploy('DisputeModule', wallet, [wallet.address]);
  const reputation = await deploy('ReputationRegistry', wallet);
  const vault = await deploy('StreamingVault', wallet, [settlementTokenAddress, reputation.address, dispute.address, COLLATERAL_TIMEOUT]);
  const points = await deploy('PlatformPoints', wallet, [wallet.address]);
  const giwaRegistry = await deploy('PACTGiwaRegistry', wallet, [wallet.address]);

  const configTransactions = {};
  configTransactions.disputeVault = await waitAndCheck(
    'DisputeModule vault',
    await dispute.contract.setVault(vault.address),
    async () => (await dispute.contract.vault()).toLowerCase() === vault.address.toLowerCase(),
  );
  configTransactions.registryWriter = await waitAndCheck(
    'ReputationRegistry writer',
    await reputation.contract.setAuthorizedWriter(vault.address, true),
    async () => reputation.contract.authorizedWriters(vault.address),
  );
  const awarder = POINTS_AWARDER || wallet.address;
  configTransactions.pointsAwarder = await waitAndCheck(
    'PlatformPoints awarder',
    await points.contract.setAuthorizedAwarder(awarder, true),
    async () => points.contract.authorizedAwarders(awarder),
  );
  const issuer = OPERATOR || wallet.address;
  configTransactions.giwaIssuer = await waitAndCheck(
    'PACTGiwaRegistry issuer',
    await giwaRegistry.contract.setIssuer(issuer, true),
    async () => giwaRegistry.contract.authorizedIssuers(issuer),
  );
  if (OPERATOR) {
    configTransactions.vaultOperator = await waitAndCheck(
      'StreamingVault operator',
      await vault.contract.setAuthorizedOperator(OPERATOR, true),
      async () => vault.contract.authorizedOperators(OPERATOR),
    );
  }

  const record = {
    network: 'giwa-sepolia',
    chainId: Number(CHAIN_ID),
    rpcUrl: RPC_URL,
    explorer: 'https://sepolia-explorer.giwa.io',
    deployedAt: new Date().toISOString(),
    deployer: wallet.address,
    operator: OPERATOR || wallet.address,
    pointsAwarder: awarder,
    collateralTimeoutSeconds: COLLATERAL_TIMEOUT.toString(),
    contracts: {
      SettlementToken: settlementTokenAddress,
      DisputeModule: dispute.address,
      ReputationRegistry: reputation.address,
      StreamingVault: vault.address,
      PlatformPoints: points.address,
      PACTGiwaRegistry: giwaRegistry.address,
    },
    transactions: {
      SettlementToken: settlementTokenDeployment,
      DisputeModule: dispute.transactionHash,
      ReputationRegistry: reputation.transactionHash,
      StreamingVault: vault.transactionHash,
      PlatformPoints: points.transactionHash,
      PACTGiwaRegistry: giwaRegistry.transactionHash,
      ...configTransactions,
    },
  };
  fs.writeFileSync(OUTPUT, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  console.log(`Deployment record: ${OUTPUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
