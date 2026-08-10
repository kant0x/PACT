import { ethers } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contractsRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(contractsRoot, '..');
const envFile = process.env.PACT_ENV_FILE
  || (fs.existsSync(path.join(workspaceRoot, 'env.txt')) ? path.join(workspaceRoot, 'env.txt') : path.join(contractsRoot, '.env'));
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);

const rpcUrl = process.env.PACT_ARC_RPC_URL || process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';
const expectedChainId = BigInt(process.env.EXPECTED_CHAIN_ID || '5042002');
const privateKey = process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY;
const usdcAddress = process.env.ARC_USDC_ADDRESS || '0x3600000000000000000000000000000000000000';
const reputationAddress = process.env.PACT_REPUTATION_REGISTRY_ADDRESS || process.env.REPUTATION_REGISTRY_ADDRESS;
const initialVerifierAddress = process.env.PACT_INITIAL_VERIFIER_ADDRESS?.trim() || null;
const collateralTimeout = Number(process.env.COLLATERAL_TIMEOUT_SECONDS || 86_400);

const isAddress = (value) => typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value);
const requireAddress = (name, value) => {
  if (!isAddress(value)) throw new Error(`${name} must be a valid EVM address`);
  return value;
};

function loadArtifact(name) {
  return JSON.parse(fs.readFileSync(path.join(contractsRoot, 'artifacts', `${name}.json`), 'utf8'));
}

async function deploy(artifact, signer, args = []) {
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function main() {
  if (!privateKey || !/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
    throw new Error('DEPLOYER_PRIVATE_KEY (or PRIVATE_KEY) is required and must be a 32-byte hex key');
  }
  requireAddress('ARC_USDC_ADDRESS', usdcAddress);
  requireAddress('PACT_REPUTATION_REGISTRY_ADDRESS', reputationAddress);
  if (initialVerifierAddress) requireAddress('PACT_INITIAL_VERIFIER_ADDRESS', initialVerifierAddress);
  if (!Number.isInteger(collateralTimeout) || collateralTimeout <= 0) throw new Error('COLLATERAL_TIMEOUT_SECONDS must be a positive integer');

  const provider = new ethers.JsonRpcProvider(rpcUrl, { name: 'arc-testnet', chainId: Number(expectedChainId) }, { staticNetwork: true });
  const wallet = new ethers.Wallet(privateKey, provider);
  const network = await provider.getNetwork();
  if (network.chainId !== expectedChainId) throw new Error(`Expected chain ${expectedChainId}, received ${network.chainId}`);
  if (await provider.getCode(usdcAddress) === '0x') throw new Error('ARC_USDC_ADDRESS has no bytecode');
  if (await provider.getCode(reputationAddress) === '0x') throw new Error('PACT_REPUTATION_REGISTRY_ADDRESS has no bytecode');

  const workOrderArtifact = loadArtifact('WorkOrderCommitments');
  const verificationArtifact = loadArtifact('VerificationRegistry');
  const disputeArtifact = loadArtifact('DisputeModule');
  const vaultArtifact = loadArtifact('StreamingVault');
  const agentArtifact = loadArtifact('AgentRegistry');
  const hubArtifact = loadArtifact('HubRegistry');
  const reputationArtifact = loadArtifact('ReputationRegistry');

  console.log(`Deploying protocol layers from ${wallet.address} on Arc Testnet…`);
  const workOrders = await deploy(workOrderArtifact, wallet, [wallet.address]);
  const verification = await deploy(verificationArtifact, wallet, [wallet.address, await workOrders.getAddress()]);
  const dispute = await deploy(disputeArtifact, wallet, [wallet.address]);
  const vault = await deploy(vaultArtifact, wallet, [
    usdcAddress,
    reputationAddress,
    await workOrders.getAddress(),
    await dispute.getAddress(),
    collateralTimeout,
  ]);
  const agentRegistry = await deploy(agentArtifact, wallet);
  const hubRegistry = await deploy(hubArtifact, wallet, [wallet.address]);

  const workOrdersWithSigner = new ethers.Contract(await workOrders.getAddress(), workOrderArtifact.abi, wallet);
  const reputationWithSigner = new ethers.Contract(reputationAddress, reputationArtifact.abi, wallet);
  const verificationWithSigner = new ethers.Contract(await verification.getAddress(), verificationArtifact.abi, wallet);
  const disputeWithSigner = new ethers.Contract(await dispute.getAddress(), disputeArtifact.abi, wallet);
  const vaultAddress = await vault.getAddress();
  await (await workOrdersWithSigner.setAuthorizedWriter(vaultAddress, true)).wait();
  await (await reputationWithSigner.setAuthorizedWriter(vaultAddress, true)).wait();
  await (await disputeWithSigner.setVault(vaultAddress)).wait();
  await (await disputeWithSigner.setVerificationRegistry(await verification.getAddress())).wait();
  if (initialVerifierAddress) await (await verificationWithSigner.setAuthorizedVerifier(initialVerifierAddress, true)).wait();

  const deployment = {
    network: 'arc-testnet',
    chainId: network.chainId.toString(),
    deployer: wallet.address,
    usdc: usdcAddress,
    contracts: {
      WorkOrderCommitments: await workOrders.getAddress(),
      VerificationRegistry: await verification.getAddress(),
      DisputeModule: await dispute.getAddress(),
      StreamingVault: vaultAddress,
      AgentRegistry: await agentRegistry.getAddress(),
      HubRegistry: await hubRegistry.getAddress(),
      ReputationRegistry: reputationAddress,
    },
    initialVerifier: initialVerifierAddress,
    collateralTimeoutSeconds: collateralTimeout,
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(contractsRoot, 'protocol-layers-deployment.json'), `${JSON.stringify(deployment, null, 2)}\n`);
  console.log(JSON.stringify(deployment, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
