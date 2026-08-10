import { ethers } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, '../..');

// The local deployment file lives at the workspace root and is ignored by Git.
// contracts/.env remains a backwards-compatible fallback. Shell/CI variables
// still win over values loaded from either file.
const envFile = process.env.PACT_ENV_FILE
  || (fs.existsSync(path.join(workspaceRoot, 'env.txt'))
    ? path.join(workspaceRoot, 'env.txt')
    : path.join(__dirname, '../.env'));
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile);
}

// Arc Testnet defaults. Override every value explicitly for another EVM network.
const ARC_RPC_URL = process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';
const EXPECTED_CHAIN_ID = BigInt(process.env.EXPECTED_CHAIN_ID || '5042002');
const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY;
const USDC_ADDRESS = process.env.ARC_USDC_ADDRESS || '0x3600000000000000000000000000000000000000';
const CONFIGURED_DISPUTE_MODULE_ADDRESS = process.env.DISPUTE_MODULE_ADDRESS?.trim() || null;
const CONFIGURED_PLATFORM_POINTS_ADDRESS = process.env.PLATFORM_POINTS_ADDRESS?.trim() || null;
const PLATFORM_POINTS_AWARDER_ADDRESS = process.env.PLATFORM_POINTS_AWARDER_ADDRESS?.trim() || null;
const COLLATERAL_TIMEOUT_SECONDS = Number(process.env.COLLATERAL_TIMEOUT_SECONDS || 86_400);
const DISPUTE_ADMIN_ADDRESS = process.env.DISPUTE_ADMIN_ADDRESS?.trim() || null;

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
  if (DISPUTE_ADMIN_ADDRESS) {
    requiredAddress('DISPUTE_ADMIN_ADDRESS', DISPUTE_ADMIN_ADDRESS);
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
  const agentRegistryArtifact = loadContract('AgentRegistry');
  const workOrderCommitmentsArtifact = loadContract('WorkOrderCommitments');
  const verificationRegistryArtifact = loadContract('VerificationRegistry');
  const hubRegistryArtifact = loadContract('HubRegistry');
  const milestoneEscrowArtifact = loadContract('MilestoneEscrow');
  const subscriptionVaultArtifact = loadContract('SubscriptionVault');
  const rewardVaultArtifact = loadContract('RewardVault');

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
    disputeModuleSource = 'pact-controlled-testnet';
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

  console.log('\nDeploying WorkOrderCommitments...');
  const WorkOrderCommitmentsFactory = new ethers.ContractFactory(
    workOrderCommitmentsArtifact.abi,
    workOrderCommitmentsArtifact.bytecode,
    wallet
  );
  const workOrderCommitmentsContract = await WorkOrderCommitmentsFactory.deploy(wallet.address);
  await workOrderCommitmentsContract.waitForDeployment();
  const workOrderCommitmentsAddress = await workOrderCommitmentsContract.getAddress();
  console.log(`WorkOrderCommitments deployed at: ${workOrderCommitmentsAddress}`);

  console.log('\nDeploying VerificationRegistry...');
  const VerificationRegistryFactory = new ethers.ContractFactory(
    verificationRegistryArtifact.abi,
    verificationRegistryArtifact.bytecode,
    wallet
  );
  const verificationRegistryContract = await VerificationRegistryFactory.deploy(wallet.address, workOrderCommitmentsAddress);
  await verificationRegistryContract.waitForDeployment();
  const verificationRegistryAddress = await verificationRegistryContract.getAddress();
  console.log(`VerificationRegistry deployed at: ${verificationRegistryAddress}`);

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
    workOrderCommitmentsAddress,
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
    const moduleVerificationTx = await disputeModuleContract.setVerificationRegistry(verificationRegistryAddress);
    await moduleVerificationTx.wait();
    if (DISPUTE_ADMIN_ADDRESS && DISPUTE_ADMIN_ADDRESS.toLowerCase() !== wallet.address.toLowerCase()) {
      const ownershipTx = await disputeModuleContract.transferOwnership(DISPUTE_ADMIN_ADDRESS);
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
  const commitmentWriterTx = await workOrderCommitmentsContract.setAuthorizedWriter(vaultAddress, true);
  await commitmentWriterTx.wait();
  if (!(await workOrderCommitmentsContract.authorizedWriters(vaultAddress))) {
    throw new Error('StreamingVault writer authorization did not persist on WorkOrderCommitments');
  }

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

  console.log('\nDeploying AgentRegistry...');
  const AgentRegistryFactory = new ethers.ContractFactory(
    agentRegistryArtifact.abi,
    agentRegistryArtifact.bytecode,
    wallet
  );
  const agentRegistryContract = await AgentRegistryFactory.deploy();
  await agentRegistryContract.waitForDeployment();
  const agentRegistryAddress = await agentRegistryContract.getAddress();
  console.log(`AgentRegistry deployed at: ${agentRegistryAddress}`);

  console.log('\nDeploying HubRegistry...');
  const HubRegistryFactory = new ethers.ContractFactory(
    hubRegistryArtifact.abi,
    hubRegistryArtifact.bytecode,
    wallet
  );
  const hubRegistryContract = await HubRegistryFactory.deploy(wallet.address);
  await hubRegistryContract.waitForDeployment();
  const hubRegistryAddress = await hubRegistryContract.getAddress();
  console.log(`HubRegistry deployed at: ${hubRegistryAddress}`);

  console.log('\nDeploying MilestoneEscrow...');
  const MilestoneEscrowFactory = new ethers.ContractFactory(
    milestoneEscrowArtifact.abi,
    milestoneEscrowArtifact.bytecode,
    wallet
  );
  const milestoneEscrowContract = await MilestoneEscrowFactory.deploy(USDC_ADDRESS);
  await milestoneEscrowContract.waitForDeployment();
  const milestoneEscrowAddress = await milestoneEscrowContract.getAddress();
  console.log(`MilestoneEscrow deployed at: ${milestoneEscrowAddress}`);

  console.log('\nDeploying SubscriptionVault...');
  const SubscriptionVaultFactory = new ethers.ContractFactory(
    subscriptionVaultArtifact.abi,
    subscriptionVaultArtifact.bytecode,
    wallet
  );
  const subscriptionVaultContract = await SubscriptionVaultFactory.deploy(USDC_ADDRESS);
  await subscriptionVaultContract.waitForDeployment();
  const subscriptionVaultAddress = await subscriptionVaultContract.getAddress();
  console.log(`SubscriptionVault deployed at: ${subscriptionVaultAddress}`);

  console.log('\nDeploying RewardVault...');
  const RewardVaultFactory = new ethers.ContractFactory(
    rewardVaultArtifact.abi,
    rewardVaultArtifact.bytecode,
    wallet
  );
  const rewardVaultContract = await RewardVaultFactory.deploy(USDC_ADDRESS, wallet.address);
  await rewardVaultContract.waitForDeployment();
  const rewardVaultAddress = await rewardVaultContract.getAddress();
  const rewardIssuerTx = await rewardVaultContract.setAuthorizedIssuer(wallet.address, true);
  await rewardIssuerTx.wait();
  if (!(await rewardVaultContract.authorizedIssuers(wallet.address))) {
    throw new Error('RewardVault issuer authorization did not persist');
  }
  console.log(`RewardVault deployed at: ${rewardVaultAddress}`);

  // Save deployment info
  const deploymentInfo = {
    network: network.chainId === 5042002n ? 'arc-testnet' : 'custom-evm',
    chainId: network.chainId.toString(),
    deployer: wallet.address,
    usdc: USDC_ADDRESS,
    disputeModule: disputeModuleAddress,
    disputeModuleSource,
    disputeModuleOwner: DISPUTE_ADMIN_ADDRESS || wallet.address,
    collateralTimeoutSeconds: COLLATERAL_TIMEOUT_SECONDS,
    registryWriterAuthorizationTx: writerTx.hash,
    contracts: {
      ReputationRegistry: reputationAddress,
      StreamingVault: vaultAddress,
      WorkOrderCommitments: workOrderCommitmentsAddress,
      VerificationRegistry: verificationRegistryAddress,
      PlatformPoints: platformPointsAddress,
      AgentRegistry: agentRegistryAddress,
      HubRegistry: hubRegistryAddress,
      MilestoneEscrow: milestoneEscrowAddress,
      SubscriptionVault: subscriptionVaultAddress,
      RewardVault: rewardVaultAddress
    },
    platformPointsAwarder: platformPointsAwarderAddress,
    platformPointsAwarderAuthorizationTx: awarderReceipts,
    rewardVaultIssuer: wallet.address,
    rewardVaultIssuerAuthorizationTx: rewardIssuerTx.hash,
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
