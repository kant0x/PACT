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
const CONFIGURED_DISPUTE_MODULE_ADDRESS = process.env.DISPUTE_MODULE_ADDRESS?.trim() || null;
const CONFIGURED_PLATFORM_POINTS_ADDRESS = process.env.PLATFORM_POINTS_ADDRESS?.trim() || null;
const PLATFORM_POINTS_AWARDER_ADDRESS = process.env.PLATFORM_POINTS_AWARDER_ADDRESS?.trim() || process.env.AUTHORIZED_OPERATOR_ADDRESS?.trim() || null;
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
  if (CONFIGURED_DISPUTE_MODULE_ADDRESS) {
    requiredAddress('DISPUTE_MODULE_ADDRESS', CONFIGURED_DISPUTE_MODULE_ADDRESS);
  }
  if (AUTHORIZED_OPERATOR_ADDRESS) {
    requiredAddress('AUTHORIZED_OPERATOR_ADDRESS', AUTHORIZED_OPERATOR_ADDRESS);
  }
  if (!Number.isSafeInteger(COLLATERAL_TIMEOUT_SECONDS) || COLLATERAL_TIMEOUT_SECONDS <= 0 || COLLATERAL_TIMEOUT_SECONDS > 0xffffffffffffffff) {
    throw new Error('COLLATERAL_TIMEOUT_SECONDS must be a positive uint64');
  }

  // Arc's public endpoint can rate-limit repeated network discovery calls.
  // Pin the expected chain so ethers does not issue an extra eth_chainId call
  // before every read; the explicit chain check below still guards deployment.
  const provider = new ethers.JsonRpcProvider(
    ARC_RPC_URL,
    {
      name: EXPECTED_CHAIN_ID === 5042002n ? 'arc-testnet' : 'configured-evm',
      chainId: Number(EXPECTED_CHAIN_ID)
    },
    { staticNetwork: true }
  );
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
  const disputeModuleArtifact = loadContract('DisputeModule');
  const platformPointsArtifact = loadContract('PlatformPoints');

  let disputeModuleContract = null;
  let disputeModuleAddress = CONFIGURED_DISPUTE_MODULE_ADDRESS;
  let disputeModuleSource = 'external';

  if (!disputeModuleAddress) {
    console.log('\nDeploying PACT DisputeModule...');
    const DisputeModuleFactory = new ethers.ContractFactory(
      disputeModuleArtifact.abi,
      disputeModuleArtifact.bytecode,
      wallet
    );
    disputeModuleContract = await DisputeModuleFactory.deploy(wallet.address);
    await disputeModuleContract.waitForDeployment();
    disputeModuleAddress = await disputeModuleContract.getAddress();
    disputeModuleSource = 'pact-controlled-demo';
    console.log(`DisputeModule deployed at: ${disputeModuleAddress}`);
  } else {
    const moduleCode = await provider.getCode(disputeModuleAddress);
    if (moduleCode === '0x') {
      throw new Error(`No contract code found at DISPUTE_MODULE_ADDRESS ${disputeModuleAddress}`);
    }
    console.log(`Using configured dispute module: ${disputeModuleAddress}`);
  }

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
    disputeModuleAddress,
    COLLATERAL_TIMEOUT_SECONDS
  );
  await vaultContract.waitForDeployment();
  const vaultAddress = await vaultContract.getAddress();
  console.log(`StreamingVault deployed at: ${vaultAddress}`);

  if (disputeModuleContract) {
    console.log('\nConfiguring DisputeModule vault...');
    const moduleVaultTx = await disputeModuleContract.setVault(vaultAddress);
    await moduleVaultTx.wait();
    if ((await disputeModuleContract.vault()).toLowerCase() !== vaultAddress.toLowerCase()) {
      throw new Error('DisputeModule vault configuration did not persist');
    }
    if (AUTHORIZED_OPERATOR_ADDRESS && AUTHORIZED_OPERATOR_ADDRESS.toLowerCase() !== wallet.address.toLowerCase()) {
      const ownershipTx = await disputeModuleContract.transferOwnership(AUTHORIZED_OPERATOR_ADDRESS);
      await ownershipTx.wait();
    }
  }

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
    || configuredDisputeModule.toLowerCase() !== disputeModuleAddress.toLowerCase()
    || configuredTimeout !== BigInt(COLLATERAL_TIMEOUT_SECONDS)
  ) {
    throw new Error('StreamingVault constructor configuration does not match the requested deployment inputs');
  }

  // Platform Points are a separate, non-transferable training ledger. They
  // never represent USDC and are awarded only after the server has finalized a
  // daily Training Ground attempt.
  let platformPointsContract = null;
  let platformPointsAddress = CONFIGURED_PLATFORM_POINTS_ADDRESS;
  if (platformPointsAddress) {
    requiredAddress('PLATFORM_POINTS_ADDRESS', platformPointsAddress);
    const pointsCode = await provider.getCode(platformPointsAddress);
    if (pointsCode === '0x') throw new Error(`No contract code found at PLATFORM_POINTS_ADDRESS ${platformPointsAddress}`);
    console.log(`Using configured PlatformPoints contract: ${platformPointsAddress}`);
  } else {
    console.log('\nDeploying PlatformPoints...');
    const PlatformPointsFactory = new ethers.ContractFactory(
      platformPointsArtifact.abi,
      platformPointsArtifact.bytecode,
      wallet
    );
    platformPointsContract = await PlatformPointsFactory.deploy(wallet.address);
    await platformPointsContract.waitForDeployment();
    platformPointsAddress = await platformPointsContract.getAddress();
    console.log(`PlatformPoints deployed at: ${platformPointsAddress}`);
  }

  const platformPointsAwarderAddress = PLATFORM_POINTS_AWARDER_ADDRESS || wallet.address;
  requiredAddress('PLATFORM_POINTS_AWARDER_ADDRESS', platformPointsAwarderAddress);
  if (!platformPointsContract) {
    platformPointsContract = new ethers.Contract(platformPointsAddress, platformPointsArtifact.abi, wallet);
  }
  const pointsAwarders = [...new Set([wallet.address.toLowerCase(), platformPointsAwarderAddress.toLowerCase()])];
  const awarderReceipts = [];
  for (const awarder of pointsAwarders) {
    const awarderTx = await platformPointsContract.setAuthorizedAwarder(awarder, true);
    await awarderTx.wait();
    if (!(await platformPointsContract.authorizedAwarders(awarder))) {
      throw new Error(`PlatformPoints awarder authorization did not persist for ${awarder}`);
    }
    awarderReceipts.push({ awarder, txHash: awarderTx.hash });
  }

  let operatorTxHash = null;
  if (AUTHORIZED_OPERATOR_ADDRESS) {
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
    disputeModule: disputeModuleAddress,
    disputeModuleSource,
    disputeModuleOwner: AUTHORIZED_OPERATOR_ADDRESS || wallet.address,
    collateralTimeoutSeconds: COLLATERAL_TIMEOUT_SECONDS,
    registryWriterAuthorizationTx: writerTx.hash,
    vaultOperatorAuthorizationTx: operatorTxHash,
    contracts: {
      ReputationRegistry: reputationAddress,
      StreamingVault: vaultAddress,
      PlatformPoints: platformPointsAddress
    },
    platformPointsAwarder: platformPointsAwarderAddress,
    platformPointsAwarderAuthorizationTx: awarderReceipts,
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
