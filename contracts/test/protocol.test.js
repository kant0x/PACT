import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserProvider, ContractFactory, keccak256, parseUnits, toUtf8Bytes } from "ethers";
import ganache from "ganache";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function artifact(name) {
  return JSON.parse(fs.readFileSync(path.join(root, "artifacts", `${name}.json`), "utf8"));
}

async function deploy(name, signer, args = []) {
  const { abi, bytecode } = artifact(name);
  const factory = new ContractFactory(abi, bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

describe("PACT protocol extensions", () => {
  let chain;
  let provider;
  let owner;
  let creator;
  let agent;
  let intruder;
  let usdc;
  let agentRegistry;
  let milestoneEscrow;
  let subscriptionVault;
  let rewardVault;

  beforeEach(async () => {
    chain = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 6, defaultBalance: 1_000 } });
    provider = new BrowserProvider(chain);
    [owner, creator, agent, intruder] = await Promise.all(
      [0, 1, 2, 3].map((index) => provider.getSigner(index)),
    );
    usdc = await deploy("MockUSDC", owner);
    agentRegistry = await deploy("AgentRegistry", owner);
    milestoneEscrow = await deploy("MilestoneEscrow", owner, [await usdc.getAddress()]);
    subscriptionVault = await deploy("SubscriptionVault", owner, [await usdc.getAddress()]);
    rewardVault = await deploy("RewardVault", owner, [await usdc.getAddress(), await owner.getAddress()]);
    await (await rewardVault.setAuthorizedIssuer(await owner.getAddress(), true)).wait();
    await (await usdc.mint(await creator.getAddress(), parseUnits("1000", 6))).wait();
    await (await usdc.mint(await owner.getAddress(), parseUnits("1000", 6))).wait();
  });

  afterEach(async () => {
    await chain.disconnect();
  });

  async function advance(seconds) {
    await provider.send("evm_increaseTime", [seconds]);
    await provider.send("evm_mine", []);
  }

  it("lets an agent self-register and update only its own profile hashes", async () => {
    const profileHash = keccak256(toUtf8Bytes("profile-v1"));
    const capabilitiesHash = keccak256(toUtf8Bytes("capabilities-v1"));
    await (await agentRegistry.connect(agent).registerAgent(profileHash, capabilitiesHash)).wait();

    expect(await agentRegistry.isRegistered(await agent.getAddress())).toBe(true);
    const profile = await agentRegistry.getAgentProfile(await agent.getAddress());
    expect(profile.profileHash).toBe(profileHash);
    expect(profile.capabilitiesHash).toBe(capabilitiesHash);
    expect(profile.active).toBe(true);

    await expect(
      agentRegistry.connect(intruder).updateAgentProfile(profileHash, capabilitiesHash),
    ).rejects.toThrow();
  });

  it("anchors the full Circle-agent registration envelope and lifecycle receipts", async () => {
    const profileHash = keccak256(toUtf8Bytes("profile-v2"));
    const capabilitiesHash = keccak256(toUtf8Bytes("capabilities-v2"));
    const documentHash = keccak256(toUtf8Bytes("complete signed agent envelope"));
    const policyHash = keccak256(toUtf8Bytes("circle-sca policy"));
    const runtimeHash = keccak256(toUtf8Bytes("external runtime requirement"));
    await (
      await agentRegistry.connect(agent).registerAgentWithCommitment(
        profileHash,
        capabilitiesHash,
        documentHash,
        policyHash,
        runtimeHash,
        await creator.getAddress(),
      )
    ).wait();
    const commitment = await agentRegistry.getAgentCommitment(await agent.getAddress());
    expect(commitment.controller).toBe(await creator.getAddress());
    expect(commitment.documentHash).toBe(documentHash);
    expect(commitment.walletPolicyHash).toBe(policyHash);
    expect(commitment.runtimeHash).toBe(runtimeHash);
    await (await agentRegistry.connect(agent).recordActivity(2, keccak256(toUtf8Bytes("restart receipt")))).wait();
    await expect(
      agentRegistry.connect(intruder).recordActivity(2, keccak256(toUtf8Bytes("forged restart"))),
    ).rejects.toThrow();
  });

  it("publishes immutable Hub specification versions", async () => {
    const hubRegistry = await deploy("HubRegistry", owner, [await owner.getAddress()]);
    const hubId = keccak256(toUtf8Bytes("training-hub"));
    const rulesHash = keccak256(toUtf8Bytes("hub rules v1"));
    const limitsHash = keccak256(toUtf8Bytes("hub limits v1"));
    const taskSpecHash = keccak256(toUtf8Bytes("hub task spec v1"));
    await (await hubRegistry.publishHubVersion(hubId, rulesHash, limitsHash, taskSpecHash, true)).wait();
    expect(await hubRegistry.hubVersionCount(hubId)).toBe(1n);
    const version = await hubRegistry.getHubVersion(hubId, 1);
    expect(version.rulesHash).toBe(rulesHash);
    expect(version.limitsHash).toBe(limitsHash);
    expect(version.taskSpecHash).toBe(taskSpecHash);
    await expect(
      hubRegistry.connect(intruder).publishHubVersion(hubId, rulesHash, limitsHash, taskSpecHash, true),
    ).rejects.toThrow();
  });

  it("stores proof hashes and lets the agent claim approved milestones", async () => {
    const amounts = [parseUnits("10", 6), parseUnits("20", 6), parseUnits("30", 6)];
    await (await usdc.connect(creator).approve(await milestoneEscrow.getAddress(), parseUnits("60", 6))).wait();
    await (await milestoneEscrow.connect(creator).createPlan(await agent.getAddress(), amounts)).wait();
    const proof = keccak256(toUtf8Bytes("deliverable-v1"));

    await (await milestoneEscrow.connect(agent).submitProof(1, 0, proof)).wait();
    expect((await milestoneEscrow.milestones(1, 0)).proofHash).toBe(proof);
    await (await milestoneEscrow.connect(creator).approveMilestone(1, 0)).wait();
    const approved = await milestoneEscrow.milestones(1, 0);
    expect(approved.status).toBe(2n);
    await (await milestoneEscrow.connect(agent).claimMilestone(1, 0)).wait();
    expect(await usdc.balanceOf(await agent.getAddress())).toBe(parseUnits("10", 6));
    expect((await milestoneEscrow.milestones(1, 0)).status).toBe(3n);
  });

  it("supports recurring agent-initiated subscription claims and future refunds", async () => {
    const periodAmount = parseUnits("25", 6);
    await (await usdc.connect(creator).approve(await subscriptionVault.getAddress(), parseUnits("50", 6))).wait();
    await (await subscriptionVault.connect(creator).createSubscription(await agent.getAddress(), periodAmount, 60, 2)).wait();
    await expect((async () => {
      const tx = await subscriptionVault.connect(agent).claimPeriod(1, keccak256(toUtf8Bytes("too-early")));
      await tx.wait();
    })()).rejects.toThrow();

    await advance(61);
    const proof = keccak256(toUtf8Bytes("weekly-result-1"));
    await (await subscriptionVault.connect(agent).claimPeriod(1, proof)).wait();
    expect(await usdc.balanceOf(await agent.getAddress())).toBe(periodAmount);
    expect((await subscriptionVault.periodClaims(1, 0)).proofHash).toBe(proof);

    await (await subscriptionVault.connect(creator).cancelSubscription(1)).wait();
    expect(await usdc.balanceOf(await creator.getAddress())).toBe(parseUnits("975", 6));
  });

  it("requires an agent to claim a USDC reward into its own Circle-compatible wallet", async () => {
    const amount = parseUnits("40", 6);
    const proof = keccak256(toUtf8Bytes("arena-reward-1"));
    await (await usdc.connect(owner).approve(await rewardVault.getAddress(), amount)).wait();
    await (await rewardVault.createReward(await agent.getAddress(), amount, proof)).wait();
    await expect((async () => {
      const tx = await rewardVault.connect(intruder).claimReward(1);
      await tx.wait();
    })()).rejects.toThrow();

    await (await rewardVault.connect(agent).claimReward(1)).wait();
    expect(await usdc.balanceOf(await agent.getAddress())).toBe(amount);
    expect((await rewardVault.rewards(1)).claimed).toBe(true);
  });
});
