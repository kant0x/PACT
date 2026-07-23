import { ethers } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const envFile = process.env.PACT_ENV_FILE || path.join(root, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);

const rpcUrl = process.env.PLATFORM_POINTS_RPC_URL || process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';
const expectedChainId = BigInt(process.env.PLATFORM_POINTS_CHAIN_ID || process.env.EXPECTED_CHAIN_ID || '5042002');
const privateKey = process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY;
const configuredAddress = process.env.PLATFORM_POINTS_ADDRESS?.trim() || null;
const configuredAwarder = process.env.PLATFORM_POINTS_AWARDER_ADDRESS?.trim() || null;
const isAddress = (value) => typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value);

async function main() {
  if (!privateKey) throw new Error('DEPLOYER_PRIVATE_KEY (or PRIVATE_KEY) is required');
  const provider = new ethers.JsonRpcProvider(rpcUrl, {
    name: expectedChainId === 5042002n ? 'arc-testnet' : 'configured-evm',
    chainId: Number(expectedChainId)
  }, { staticNetwork: true });
  const wallet = new ethers.Wallet(privateKey, provider);
  const network = await provider.getNetwork();
  if (network.chainId !== expectedChainId && process.env.ALLOW_ANY_CHAIN !== 'true') {
    throw new Error(`Unexpected chain id ${network.chainId}; expected ${expectedChainId}`);
  }
  const awarder = configuredAwarder || wallet.address;
  if (!isAddress(awarder)) throw new Error('PLATFORM_POINTS_AWARDER_ADDRESS must be a valid EVM address');
  const artifact = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'PlatformPoints.json'), 'utf8'));
  let address = configuredAddress;
  let contract;

  if (address) {
    if (!isAddress(address)) throw new Error('PLATFORM_POINTS_ADDRESS must be a valid EVM address');
    if ((await provider.getCode(address)) === '0x') throw new Error(`No contract code found at ${address}`);
    contract = new ethers.Contract(address, artifact.abi, wallet);
    console.log(`Using existing PlatformPoints: ${address}`);
  } else {
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
    contract = await factory.deploy(wallet.address);
    await contract.waitForDeployment();
    address = await contract.getAddress();
    console.log(`PlatformPoints deployed: ${address}`);
  }

  const awarders = [...new Set([wallet.address.toLowerCase(), awarder.toLowerCase()])];
  const authorizationReceipts = [];
  for (const awarderAddress of awarders) {
    const tx = await contract.setAuthorizedAwarder(awarderAddress, true);
    await tx.wait();
    if (!(await contract.authorizedAwarders(awarderAddress))) throw new Error(`PlatformPoints awarder authorization did not persist for ${awarderAddress}`);
    authorizationReceipts.push({ awarder: awarderAddress, txHash: tx.hash });
  }

  const deploymentsPath = path.join(root, 'deployments.json');
  const existing = fs.existsSync(deploymentsPath) ? JSON.parse(fs.readFileSync(deploymentsPath, 'utf8')) : {};
  const next = {
    ...existing,
    network: network.chainId === 5042002n ? 'arc-testnet' : existing.network || 'custom-evm',
    chainId: network.chainId.toString(),
    contracts: { ...(existing.contracts || {}), PlatformPoints: address },
    platformPointsAwarder: awarder,
    platformPointsAwarderAuthorizationTx: authorizationReceipts,
    platformPointsDeployedAt: new Date().toISOString()
  };
  fs.writeFileSync(deploymentsPath, JSON.stringify(next, null, 2));
  console.log(`PlatformPoints awarder authorized: ${awarder}`);
  console.log(`Receipts: ${authorizationReceipts.map((item) => `${item.awarder} ${item.txHash}`).join(', ')}`);
  console.log(`Saved ${deploymentsPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
