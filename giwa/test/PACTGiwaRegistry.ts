import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { keccak256, stringToHex } from "viem";

describe("PACTGiwaRegistry", async () => {
  const { viem } = await network.connect();
  const [owner, issuer, agent, outsider] = await viem.getWalletClients();

  async function deployRegistry() {
    return viem.deployContract("PACTGiwaRegistry", [owner.account.address]);
  }

  it("registers an agent and updates only that agent's profile", async () => {
    const registry = await deployRegistry();
    const firstHash = keccak256(stringToHex("ipfs://pact-agent-v1"));
    const secondHash = keccak256(stringToHex("ipfs://pact-agent-v2"));

    await registry.write.registerAgent([firstHash], { account: agent.account });
    let profile = await registry.read.getAgent([agent.account.address]);
    assert.equal(profile.profileHash, firstHash);
    assert.ok(profile.registeredAt > 0n);

    await registry.write.registerAgent([secondHash], { account: agent.account });
    profile = await registry.read.getAgent([agent.account.address]);
    assert.equal(profile.profileHash, secondHash);
    assert.equal(profile.registeredAt <= profile.updatedAt, true);
  });

  it("accepts one issuer-signed receipt and rejects replay", async () => {
    const registry = await deployRegistry();
    const profileHash = keccak256(stringToHex("agent-profile"));
    const taskId = keccak256(stringToHex("pact-task-42"));
    const evidenceHash = keccak256(stringToHex("task-result-proof"));

    await registry.write.registerAgent([profileHash], { account: agent.account });
    await registry.write.setIssuer([issuer.account.address, true], { account: owner.account });
    await registry.write.recordTask(
      [agent.account.address, taskId, true, 250n, evidenceHash],
      { account: issuer.account },
    );

    const profile = await registry.read.getAgent([agent.account.address]);
    const receipt = await registry.read.getTaskReceipt([taskId]);
    assert.equal(profile.completedTasks, 1n);
    assert.equal(profile.successfulTasks, 1n);
    assert.equal(profile.reputationPoints, 250n);
    assert.equal(receipt.agent.toLowerCase(), agent.account.address.toLowerCase());
    assert.equal(receipt.evidenceHash, evidenceHash);

    await assert.rejects(
      registry.write.recordTask(
        [agent.account.address, taskId, true, 250n, evidenceHash],
        { account: issuer.account },
      ),
    );
  });

  it("rejects task receipts from an unauthorized account", async () => {
    const registry = await deployRegistry();
    const profileHash = keccak256(stringToHex("agent-profile"));
    const taskId = keccak256(stringToHex("pact-task-43"));
    const evidenceHash = keccak256(stringToHex("task-result-proof"));

    await registry.write.registerAgent([profileHash], { account: agent.account });

    await assert.rejects(
      registry.write.recordTask(
        [agent.account.address, taskId, true, 10n, evidenceHash],
        { account: outsider.account },
      ),
    );
  });
});
