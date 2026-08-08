import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AbiCoder, BrowserProvider, ContractFactory, Wallet, ZeroAddress, keccak256, parseUnits, toUtf8Bytes } from "ethers";
import ganache from "ganache";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ONE_USDC = parseUnits("1", 6);

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

describe("PACT contracts", () => {
  let chain;
  let provider;
  let owner;
  let creator;
  let agent;
  let dispute;
  let intruder;
  let underwriter;
  let usdc;
  let registry;
  let vault;

  beforeEach(async () => {
    chain = ganache.provider({
      logging: { quiet: true },
      wallet: { totalAccounts: 8, defaultBalance: 1_000 },
    });
    provider = new BrowserProvider(chain);
    [owner, creator, agent, dispute, intruder, underwriter] = await Promise.all(
      [0, 1, 2, 3, 4, 5].map((index) => provider.getSigner(index)),
    );

    usdc = await deploy("MockUSDC", owner);
    registry = await deploy("ReputationRegistry", owner);
    vault = await deploy("StreamingVault", owner, [
      await usdc.getAddress(),
      await registry.getAddress(),
      await dispute.getAddress(),
      3_600,
    ]);
    await (await registry.addAuthorizedWriter(await vault.getAddress())).wait();

    await (await usdc.mint(await creator.getAddress(), parseUnits("1000", 6))).wait();
    await (await usdc.mint(await agent.getAddress(), parseUnits("500", 6))).wait();
    await (await usdc.mint(await underwriter.getAddress(), parseUnits("500", 6))).wait();
  });

  afterEach(async () => {
    await chain.disconnect();
  });

  async function createTask(amount = "500", collateralPct = 50) {
    const value = parseUnits(amount, 6);
    await (await usdc.connect(creator).approve(await vault.getAddress(), value)).wait();
    await (
      await vault
        .connect(creator)
        .createTask(await agent.getAddress(), value, collateralPct)
    ).wait();
    return value;
  }

  async function postCollateral(taskId = 1n) {
    const task = await vault.tasks(taskId);
    await (
      await usdc.connect(agent).approve(await vault.getAddress(), task.requiredCollateral)
    ).wait();
    await (await vault.connect(agent).postCollateral(taskId)).wait();
  }

  async function submitResultProof(taskId = 1n, label = "deliverable-proof") {
    await (
      await vault
        .connect(agent)
        .submitResultProof(taskId, keccak256(toUtf8Bytes(`${label}-${taskId}`)))
    ).wait();
  }

  async function advance(seconds) {
    await provider.send("evm_increaseTime", [seconds]);
    await provider.send("evm_mine", []);
  }

  it("runs create -> collateral -> stream -> partial withdraw -> complete", async () => {
    const totalAmount = await createTask();
    await postCollateral();
    await (await vault.connect(creator).startStream(1, ONE_USDC)).wait();

    await advance(10);
    const available = await vault.withdrawableAmount(1);
    expect(available).toBeGreaterThanOrEqual(parseUnits("10", 6));
    expect(available).toBeLessThan(totalAmount);

    await (await vault.connect(agent).withdrawStreamed(1)).wait();
    const afterWithdrawal = await vault.tasks(1);
    expect(afterWithdrawal.withdrawnAmount).toBeGreaterThan(0n);
    expect(afterWithdrawal.withdrawnAmount).toBeLessThan(totalAmount);

    await submitResultProof();
    await (await vault.connect(creator).completeTask(1)).wait();
    const completed = await vault.tasks(1);
    expect(completed.status).toBe(5n);
    expect(completed.withdrawnAmount).toBe(totalAmount);
    expect(completed.collateralLocked).toBe(0n);
    expect(await usdc.balanceOf(await agent.getAddress())).toBe(parseUnits("1000", 6));
    expect(await usdc.balanceOf(await vault.getAddress())).toBe(0n);

    const history = await registry.getAgentHistory(await agent.getAddress());
    expect(history.completedTasks).toBe(1n);
    expect(history.failedTasks).toBe(0n);
    expect(history.totalVolume).toBe(totalAmount);
  });

  it("pauses and applies a full collateral slash with earned-stream settlement", async () => {
    const totalAmount = await createTask("300", 50);
    await postCollateral();
    await (await vault.connect(creator).startStream(1, ONE_USDC)).wait();
    await advance(7);
    await (await vault.connect(creator).pauseStream(1)).wait();

    const accrued = await vault.accruedAmount(1);
    expect(accrued).toBeGreaterThanOrEqual(parseUnits("7", 6));
    await (await vault.connect(dispute).slashCollateral(1, 100)).wait();

    const slashed = await vault.tasks(1);
    expect(slashed.status).toBe(6n);
    expect(slashed.collateralLocked).toBe(0n);
    expect(slashed.withdrawnAmount).toBe(accrued);
    expect(await usdc.balanceOf(await vault.getAddress())).toBe(0n);

    const creatorBalance = await usdc.balanceOf(await creator.getAddress());
    expect(creatorBalance).toBe(parseUnits("1150", 6) - accrued);
    expect(await usdc.balanceOf(await agent.getAddress())).toBe(parseUnits("350", 6) + accrued);

    const history = await registry.getAgentHistory(await agent.getAddress());
    expect(history.completedTasks).toBe(0n);
    expect(history.failedTasks).toBe(1n);
    expect(history.totalVolume).toBe(accrued);
  });

  it("returns creator funds after the collateral deadline", async () => {
    const totalAmount = await createTask("100", 50);
    expect(await usdc.balanceOf(await creator.getAddress())).toBe(parseUnits("900", 6));
    await advance(3_601);

    const required = (await vault.tasks(1)).requiredCollateral;
    await (await usdc.connect(agent).approve(await vault.getAddress(), required)).wait();
    await expect(vault.connect(agent).postCollateral(1)).rejects.toThrow();
    await expect(vault.connect(intruder).cancelTaskAfterTimeout(1)).rejects.toThrow();

    await (await vault.connect(creator).cancelTaskAfterTimeout(1)).wait();
    const cancelled = await vault.tasks(1);
    expect(cancelled.status).toBe(7n);
    expect(await usdc.balanceOf(await creator.getAddress())).toBe(parseUnits("1000", 6));
    expect(await usdc.balanceOf(await vault.getAddress())).toBe(0n);
    expect(totalAmount).toBe(parseUnits("100", 6));
  });

  it("funds an open order, assigns the claiming agent, and completes it", async () => {
    const totalAmount = parseUnits("120", 6);
    await (await usdc.connect(creator).approve(await vault.getAddress(), totalAmount)).wait();
    await (await vault.connect(creator).createOpenTask(totalAmount, ONE_USDC, ZeroAddress)).wait();

    const open = await vault.tasks(1);
    expect(open.creator).toBe(await creator.getAddress());
    expect(open.agent).toBe("0x0000000000000000000000000000000000000000");
    expect(open.requiredCollateral).toBe(0n);
    expect(open.collateralDeadline).toBe(0n);
    expect(open.status).toBe(1n);

    await expect(
      vault.connect(underwriter).underwriteCollateral(1, parseUnits("1", 6)),
    ).rejects.toThrow();
    await (await vault.connect(agent).claimOpenTask(1)).wait();
    const assigned = await vault.tasks(1);
    expect(assigned.agent).toBe(await agent.getAddress());
    expect(assigned.requiredCollateral).toBe(parseUnits("60", 6));
    expect(assigned.collateralDeadline).toBeGreaterThan(0n);
    await expect((async () => {
      const duplicate = await vault.connect(intruder).claimOpenTask(1);
      await duplicate.wait();
    })()).rejects.toThrow();

    await postCollateral();
    expect((await vault.tasks(1)).status).toBe(3n);
    await submitResultProof();
    await (await vault.connect(creator).completeTask(1)).wait();

    const completed = await vault.tasks(1);
    expect(completed.status).toBe(5n);
    expect(await usdc.balanceOf(await vault.getAddress())).toBe(0n);
  });

  it("enforces an invited agent on-chain", async () => {
    const totalAmount = parseUnits("40", 6);
    const invitedAgent = await agent.getAddress();
    await (await usdc.connect(creator).approve(await vault.getAddress(), totalAmount)).wait();
    await (await vault.connect(creator).createOpenTask(totalAmount, ONE_USDC, invitedAgent)).wait();

    expect(await vault.preferredAgents(1)).toBe(invitedAgent);
    await expect(vault.connect(intruder).claimOpenTask(1)).rejects.toThrow();
    await (await vault.connect(agent).claimOpenTask(1)).wait();
    expect((await vault.tasks(1)).agent).toBe(invitedAgent);
  });

  it("lets the creator cancel an unclaimed funded order", async () => {
    const totalAmount = parseUnits("75", 6);
    await (await usdc.connect(creator).approve(await vault.getAddress(), totalAmount)).wait();
    await (await vault.connect(creator).createOpenTask(totalAmount, ONE_USDC, ZeroAddress)).wait();
    expect(await usdc.balanceOf(await creator.getAddress())).toBe(parseUnits("925", 6));

    await expect(vault.connect(intruder).cancelOpenTask(1)).rejects.toThrow();
    await (await vault.connect(creator).cancelOpenTask(1)).wait();

    const cancelled = await vault.tasks(1);
    expect(cancelled.status).toBe(7n);
    expect(await usdc.balanceOf(await creator.getAddress())).toBe(parseUnits("1000", 6));
    expect(await usdc.balanceOf(await vault.getAddress())).toBe(0n);
  });

  it("rejects unauthorized lifecycle calls and duplicate reputation outcomes", async () => {
    await expect(
      registry.connect(intruder).recordTaskOutcome(await agent.getAddress(), 9_001, true, 1),
    ).rejects.toThrow();

    await (await registry.addAuthorizedWriter(await owner.getAddress())).wait();
    await (
      await registry.recordTaskOutcome(await agent.getAddress(), 9_001, true, ONE_USDC)
    ).wait();
    await expect(
      registry.recordTaskOutcome(await agent.getAddress(), 9_001, false, ONE_USDC),
    ).rejects.toThrow();

    await createTask("200", 25);
    await expect(vault.connect(intruder).postCollateral(1)).rejects.toThrow();
    await postCollateral();
    await expect(vault.connect(intruder).startStream(1, ONE_USDC)).rejects.toThrow();
    await (await vault.connect(creator).startStream(1, ONE_USDC)).wait();
    await expect(vault.connect(intruder).pauseStream(1)).rejects.toThrow();
    // Ganache's fallback JS engine can occasionally reuse the gas estimate from
    // the immediately preceding reverted call on Windows. An explicit ceiling
    // keeps this authorization test deterministic without changing execution.
    await (await vault.connect(creator).pauseStream(1, { gasLimit: 1_000_000 })).wait();
    await expect(vault.connect(intruder).resumeStream(1)).rejects.toThrow();
    await (await vault.connect(creator).resumeStream(1, { gasLimit: 1_000_000 })).wait();
    await expect(vault.connect(intruder).completeTask(1)).rejects.toThrow();
    await expect(vault.connect(intruder).slashCollateral(1, 100)).rejects.toThrow();
  });

  it("allows a whitelisted third-party protocol to write and paginate public history", async () => {
    const protocol = await deploy("ThirdPartyProtocolMock", owner, [await registry.getAddress()]);
    const protocolAddress = await protocol.getAddress();

    await expect(
      protocol.publishOutcome(await agent.getAddress(), 76, true, parseUnits("25", 6)),
    ).rejects.toThrow();
    await (await registry.addAuthorizedWriter(protocolAddress)).wait();
    await (
      await protocol.publishOutcome(
        await agent.getAddress(),
        77,
        true,
        parseUnits("25", 6),
      )
    ).wait();

    const [page, total] = await protocol.readHistory(await agent.getAddress(), 0, 10);
    expect(total).toBe(1n);
    expect(page).toHaveLength(1);
    expect(page[0].writer).toBe(protocolAddress);
    expect(page[0].taskId).toBe(77n);
    expect(page[0].success).toBe(true);

    // Task IDs are scoped by writer, so two independent protocols cannot collide.
    await (await registry.addAuthorizedWriter(await owner.getAddress())).wait();
    await (
      await registry.recordTaskOutcome(
        await agent.getAddress(),
        77,
        false,
        parseUnits("5", 6),
        { gasLimit: 300_000 },
      )
    ).wait();
    const [, updatedTotal] = await protocol.readHistory(await agent.getAddress(), 1, 1);
    expect(updatedTotal).toBe(2n);
  });

  it("starts with third-party collateral and pays the proportional underwriting fee", async () => {
    await createTask("1000", 100);
    const contribution = parseUnits("500", 6);
    const unfunded = await vault.tasks(1);
    expect(await usdc.balanceOf(await agent.getAddress())).toBeLessThan(
      unfunded.requiredCollateral,
    );
    await (
      await usdc.connect(underwriter).approve(await vault.getAddress(), contribution)
    ).wait();
    await (await vault.connect(underwriter).underwriteCollateral(1, contribution)).wait();

    const beforePost = await vault.tasks(1);
    expect(beforePost.requiredCollateral).toBe(parseUnits("1000", 6));
    expect(beforePost.totalUnderwritten).toBe(contribution);
    await postCollateral();
    const funded = await vault.tasks(1);
    expect(funded.agentCollateral).toBe(parseUnits("500", 6));
    expect(funded.collateralLocked).toBe(parseUnits("1000", 6));

    await (await vault.connect(creator).startStream(1, ONE_USDC)).wait();
    await submitResultProof(1, "underwritten-deliverable");
    await (await vault.connect(creator).completeTask(1)).wait();

    // 2% of the stream, weighted by 500/1000 of collateral = 10 USDC.
    expect(await usdc.balanceOf(await underwriter.getAddress())).toBe(
      parseUnits("510", 6),
    );
    expect(await usdc.balanceOf(await agent.getAddress())).toBe(parseUnits("1490", 6));
    expect(await usdc.balanceOf(await vault.getAddress())).toBe(0n);
  });

  it("shares slashing loss proportionally between agent and underwriter", async () => {
    await createTask("300", 50);
    const contribution = parseUnits("60", 6);
    await (
      await usdc.connect(underwriter).approve(await vault.getAddress(), contribution)
    ).wait();
    await (await vault.connect(underwriter).underwriteCollateral(1, contribution)).wait();
    await postCollateral();
    await (await vault.connect(creator).startStream(1, ONE_USDC)).wait();
    await advance(5);
    await (await vault.connect(creator).pauseStream(1)).wait();
    await (await vault.connect(dispute).slashCollateral(1, 50)).wait();

    // Underwriter committed 60 and receives 30 back: exactly the same 50% risk.
    expect(await usdc.balanceOf(await underwriter.getAddress())).toBe(
      parseUnits("470", 6),
    );
    const settled = await vault.tasks(1);
    expect(settled.status).toBe(6n);
    expect(settled.collateralLocked).toBe(0n);
    expect(await usdc.balanceOf(await vault.getAddress())).toBe(0n);
  });

  it("imports an authorized EIP-712 reputation attestation once and caps trust", async () => {
    const [firstAccount] = Object.values(chain.getInitialAccounts());
    const attestor = new Wallet(firstAccount.secretKey);
    await (await registry.setAuthorizedAttestor(await attestor.getAddress(), true)).wait();
    const network = await provider.getNetwork();
    const latestBlock = await provider.getBlock("latest");
    const deadline = BigInt(latestBlock.timestamp + 3_600);
    const value = {
      agent: await agent.getAddress(),
      sourceDomain: 3,
      externalScore: 720n,
      completedTasks: 18n,
      failedTasks: 1n,
      totalVolume: parseUnits("12000", 6),
      nonce: 1n,
      deadline,
    };
    const signature = await attestor.signTypedData(
      {
        name: "PACT Reputation Registry",
        version: "1",
        chainId: network.chainId,
        verifyingContract: await registry.getAddress(),
      },
      {
        ExternalReputation: [
          { name: "agent", type: "address" },
          { name: "sourceDomain", type: "uint32" },
          { name: "externalScore", type: "uint256" },
          { name: "completedTasks", type: "uint256" },
          { name: "failedTasks", type: "uint256" },
          { name: "totalVolume", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      value,
    );
    const proof = AbiCoder.defaultAbiCoder().encode(
      [
        "tuple(uint32 sourceDomain,uint256 externalScore,uint256 completedTasks,uint256 failedTasks,uint256 totalVolume,uint256 nonce,uint256 deadline,bytes signature)",
      ],
      [[
        value.sourceDomain,
        value.externalScore,
        value.completedTasks,
        value.failedTasks,
        value.totalVolume,
        value.nonce,
        value.deadline,
        signature,
      ]],
    );

    await (await registry.connect(intruder).importExternalAttestation(value.agent, proof)).wait();
    const imported = await registry.getPortableReputation(value.agent);
    expect(imported.claimedScore).toBe(720n);
    expect(imported.recognizedScore).toBe(400n);
    expect(imported.completedTasks).toBe(18n);
    expect(imported.attestor).toBe(await attestor.getAddress());
    const replay = await registry
      .connect(intruder)
      .importExternalAttestation(value.agent, proof);
    await expect(replay.wait()).rejects.toThrow();
  });

  it("routes one finalized decision through the protected dispute module", async () => {
    const module = await deploy("DisputeModule", owner, [await owner.getAddress()]);
    await (await module.setVault(await vault.getAddress())).wait();
    await (await vault.setDisputeModule(await module.getAddress())).wait();

    await createTask("300", 50);
    await postCollateral();
    await (await vault.connect(creator).startStream(1, ONE_USDC)).wait();
    await advance(5);
    await (await vault.connect(creator).pauseStream(1)).wait();

    const decisionHash = keccak256(toUtf8Bytes("pact-demo-finalized-decision-1"));
    await (await module.settle(1, 50, decisionHash)).wait();
    const settled = await vault.tasks(1);
    expect(settled.status).toBe(6n);
    expect(await module.executedDecisions(decisionHash)).toBe(true);

    await expect(module.settle(1, 50, decisionHash)).rejects.toThrow();
    await expect(
      module.connect(intruder).settle(1, 50, keccak256(toUtf8Bytes("intruder"))),
    ).rejects.toThrow();
  });

  it("lets either participant freeze a dispute and resumes a no-fault decision", async () => {
    const module = await deploy("DisputeModule", owner, [await owner.getAddress()]);
    await (await module.setVault(await vault.getAddress())).wait();
    await (await vault.setDisputeModule(await module.getAddress())).wait();

    await createTask("100", 50);
    await postCollateral();
    await (await vault.connect(creator).startStream(1, ONE_USDC)).wait();
    await (await vault.connect(agent).pauseForDispute(1)).wait();
    expect((await vault.tasks(1)).status).toBe(4n);

    const decisionHash = keccak256(toUtf8Bytes("pact-no-fault-decision"));
    await (await module.settle(1, 0, decisionHash)).wait();
    expect((await vault.tasks(1)).status).toBe(3n);
    expect(await module.executedDecisions(decisionHash)).toBe(true);
  });

  it("awards non-transferable platform points once per training attempt", async () => {
    const points = await deploy("PlatformPoints", owner, [await owner.getAddress()]);
    const attemptId = keccak256(toUtf8Bytes("arena-attempt-1"));

    await expect((async () => {
      const unauthorized = await points.connect(intruder).awardPoints(await agent.getAddress(), 30, attemptId);
      await unauthorized.wait();
    })()).rejects.toThrow();

    await (await points.setAuthorizedAwarder(await owner.getAddress(), true)).wait();
    await (await points.awardPoints(await agent.getAddress(), 30, attemptId)).wait();

    expect(await points.pointsOf(await agent.getAddress())).toBe(30n);
    expect(await points.totalIssued()).toBe(30n);
    expect(await points.awardedAttempts(attemptId)).toBe(true);

    await expect((async () => {
      const duplicate = await points.awardPoints(await agent.getAddress(), 30, attemptId);
      await duplicate.wait();
    })()).rejects.toThrow();
    await expect((async () => {
      const zero = await points.awardPoints(await agent.getAddress(), 0, keccak256(toUtf8Bytes("zero")));
      await zero.wait();
    })()).rejects.toThrow();
  });
});
