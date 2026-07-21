import { ethers } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load contracts/.env automatically for an operator-friendly deployment. Shell
// variables still win, so CI/secret-manager values override the file.
const envFile = process.env.PACT_ENV_FILE || path.join(__dirname, '../.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile);
}

// Arc Testnet defaults. Override every value explicitly for another EVM network.
const ARC_RPC_URL = process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';
const EXPECTED_CHAIN_ID = BigInt(process.env.EXPECTED_CHAIN_ID || '5042002');
const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY;
const USDC_ADDRESS = process.env.ARC_USDC_ADDRESS;
const DISPUTE_MODULE_ADDRESS = process.env.DISPUTE_MODULE_ADDRESS;
const COLLATERAL_TIMEOUT_SECONDS = Number(process.env.COLLATERAL_TIMEOUT_SECONDS || 86_400);
const AUTHORIZED_OPERATOR_ADDRESS = process.env.AUTHORIZED_OPERATOR_ADDRESS;

const isAddress = (value) => typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value);

const requiredAddress = (name, value) => {
  if (!isAddress(value)) {
    throw new Error(`${name} must be a valid EVM address`);
  }
  return value;
};

async function main() {
  if (!PRIVATE_KEY) {
    console.error('ERROR: DEPLOYER_PRIVATE_KEY (or PRIVATE_KEY) is required for deployment.');
    process.exit(1);
  }
  requiredAddress('ARC_USDC_ADDRESS', USDC_ADDRESS);
  requiredAddress('DISPUTE_MODULE_ADDRESS', DISPUTE_MODULE_ADDRESS);
  if (!Number.isSafeInteger(COLLATERAL_TIMEOUT_SECONDS) || COLLATERAL_TIMEOUT_SECONDS <= 0 || COLLATERAL_TIMEOUT_SECONDS > 0xffffffffffffffff) {
    throw new Error('COLLATERAL_TIMEOUT_SECONDS must be a positive uint64');
  }

  const provider = new ethers.JsonRpcProvider(ARC_RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  const network = await provider.getNetwork();
  console.log(`Connected to chain ${network.chainId.toString()} via ${ARC_RPC_URL}`);
  if (network.chainId !== EXPECTED_CHAIN_ID && process.env.ALLOW_ANY_CHAIN !== 'true') {
    throw new Error(`Unexpected chain id ${network.chainId}. Expected ${EXPECTED_CHAIN_ID}. Set ALLOW_ANY_CHAIN=true only for an intentional alternate network.`);
  }

  console.log(`Deploying from account: ${wallet.address}`);
  const balance = await provider.getBalance(wallet.address);
  console.log(`Account balance: ${ethers.formatEther(balance)} ETH`);
  const usdcCode = await provider.getCode(USDC_ADDRESS);
  if (usdcCode === '0x') throw new Error(`No contract code found at ARC_USDC_ADDRESS ${USDC_ADDRESS}`);

  // Load compiled artifacts
  const artifactsDir = path.join(__dirname, '../artifacts');

  if (!fs.existsSync(artifactsDir)) {
    console.error('ERROR: Artifacts not found. Run npm run build first.');
    process.exit(1);
  }

  const loadContract = (name) => {
    const raw = fs.readFileSync(path.join(artifactsDir, `${name}.json`), 'utf-8');
    return JSON.parse(raw);
  };

  const reputationArtifact = loadContract('ReputationRegistry');
  const vaultArtifact = loadContract('StreamingVault');

  // 1. Deploy ReputationRegistry
  console.log('\nDeploying ReputationRegistry...');
  const ReputationFactory = new ethers.ContractFactory(
    reputationArtifact.abi,
    reputationArtifact.bytecode,
    wallet
  );
  const reputationContract = await ReputationFactory.deploy();
  await reputationContract.waitForDeployment();
  const reputationAddress = await reputationContract.getAddress();
  console.log(`ReputationRegistry deployed at: ${reputationAddress}`);

  // 2. Deploy StreamingVault
  console.log('\nDeploying StreamingVault...');
  const VaultFactory = new ethers.ContractFactory(
    vaultArtifact.abi,
    vaultArtifact.bytecode,
    wallet
  );
  const vaultContract = await VaultFactory.deploy(
    USDC_ADDRESS,
    reputationAddress,
    DISPUTE_MODULE_ADDRESS,
    COLLATERAL_TIMEOUT_SECONDS
  );
  await vaultContract.waitForDeployment();
  const vaultAddress = await vaultContract.getAddress();
  console.log(`StreamingVault deployed at: ${vaultAddress}`);

  // The vault records outcomes in the registry. This writer authorization must
  // be completed before any real task can settle successfully.
  console.log('\nAuthorizing StreamingVault as a registry writer...');
  const writerTx = await reputationContract.setAuthorizedWriter(vaultAddress, true);
  await writerTx.wait();
  if (!(await reputationContract.authorizedWriters(vaultAddress))) {
    throw new Error('StreamingVault writer authorization did not persist on ReputationRegistry');
  }
  console.log(`Registry writer authorization confirmed in ${writerTx.hash}`);

  const [configuredUsdc, configuredRegistry, configuredDisputeModule, configuredTimeout] = await Promise.all([
    vaultContract.usdc(),
    vaultContract.reputationRegistry(),
    vaultContract.disputeModule(),
    vaultContract.collateralTimeout()
  ]);
  if (
    configuredUsdc.toLowerCase() !== USDC_ADDRESS.toLowerCase()
    || configuredRegistry.toLowerCase() !== reputationAddress.toLowerCase()
    || configuredDisputeModule.toLowerCase() !== DISPUTE_MODULE_ADDRESS.toLowerCase()
    || configuredTimeout !== BigInt(COLLATERAL_TIMEOUT_SECONDS)
  ) {
    throw new Error('StreamingVault constructor configuration does not match the requested deployment inputs');
  }

  let operatorTxHash = null;
  if (AUTHORIZED_OPERATOR_ADDRESS) {
    requiredAddress('AUTHORIZED_OPERATOR_ADDRESS', AUTHORIZED_OPERATOR_ADDRESS);
    console.log(`\nAuthorizing operator ${AUTHORIZED_OPERATOR_ADDRESS} on StreamingVault...`);
    const operatorTx = await vaultContract.setAuthorizedOperator(AUTHORIZED_OPERATOR_ADDRESS, true);
    await operatorTx.wait();
    operatorTxHash = operatorTx.hash;
    console.log(`Vault operator authorization confirmed in ${operatorTx.hash}`);
  }

  // Save deployment info
  const deploymentInfo = {
    network: network.chainId === 5042002n ? 'arc-testnet' : 'custom-evm',
    chainId: network.chainId.toString(),
    deployer: wallet.address,
    usdc: USDC_ADDRESS,
    disputeModule: DISPUTE_MODULE_ADDRESS,
    collateralTimeoutSeconds: COLLATERAL_TIMEOUT_SECONDS,
    registryWriterAuthorizationTx: writerTx.hash,
    vaultOperatorAuthorizationTx: operatorTxHash,
    contracts: {
      ReputationRegistry: reputationAddress,
      StreamingVault: vaultAddress
    },
    deployedAt: new Date().toISOString()
  };

  fs.writeFileSync(
    path.join(__dirname, '../deployments.json'),
    JSON.stringify(deploymentInfo, null, 2)
  );

  console.log('\nDeployment saved to deployments.json');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
