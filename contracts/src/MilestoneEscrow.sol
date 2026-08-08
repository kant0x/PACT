// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMilestoneERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice USDC escrow that releases independently claimable milestone rewards.
/// @dev The agent submits a proof hash, the creator approves it, and the agent
///      signs the final claim from its own wallet (including a Circle SCA).
contract MilestoneEscrow {
    uint256 public constant MAX_MILESTONES = 32;

    enum MilestoneStatus {
        PENDING,
        PROOF_SUBMITTED,
        APPROVED,
        CLAIMED
    }

    struct Plan {
        address creator;
        address agent;
        uint256 totalAmount;
        uint256 claimedAmount;
        uint256 milestoneCount;
        bool active;
    }

    struct Milestone {
        uint256 amount;
        bytes32 proofHash;
        uint64 submittedAt;
        uint64 approvedAt;
        MilestoneStatus status;
    }

    IMilestoneERC20 public immutable usdc;
    uint256 public nextPlanId = 1;
    mapping(uint256 => Plan) public plans;
    mapping(uint256 => mapping(uint256 => Milestone)) public milestones;

    error Unauthorized();
    error InvalidAmount();
    error InvalidMilestone();
    error InvalidState(MilestoneStatus current);
    error PlanInactive();
    error EmptyProof();
    error TransferFailed();
    error ApprovedMilestonePending();

    event PlanCreated(
        uint256 indexed planId,
        address indexed creator,
        address indexed agent,
        uint256 totalAmount,
        uint256 milestoneCount
    );
    event ProofSubmitted(uint256 indexed planId, uint256 indexed milestoneId, bytes32 proofHash);
    event ProofRejected(uint256 indexed planId, uint256 indexed milestoneId, bytes32 proofHash);
    event MilestoneApproved(uint256 indexed planId, uint256 indexed milestoneId, uint256 amount);
    event MilestoneClaimed(
        uint256 indexed planId,
        uint256 indexed milestoneId,
        address indexed agent,
        uint256 amount,
        bytes32 proofHash
    );
    event PlanCancelled(uint256 indexed planId, uint256 refundedAmount);

    constructor(address usdcAddress) {
        if (usdcAddress == address(0)) revert InvalidAmount();
        usdc = IMilestoneERC20(usdcAddress);
    }

    function createPlan(address agent, uint256[] calldata amounts)
        external
        returns (uint256 planId)
    {
        if (agent == address(0) || amounts.length == 0 || amounts.length > MAX_MILESTONES) {
            revert InvalidMilestone();
        }

        uint256 totalAmount;
        for (uint256 i = 0; i < amounts.length; ++i) {
            if (amounts[i] == 0) revert InvalidAmount();
            totalAmount += amounts[i];
        }

        planId = nextPlanId++;
        plans[planId] = Plan({
            creator: msg.sender,
            agent: agent,
            totalAmount: totalAmount,
            claimedAmount: 0,
            milestoneCount: amounts.length,
            active: true
        });
        for (uint256 i = 0; i < amounts.length; ++i) {
            milestones[planId][i] = Milestone({
                amount: amounts[i],
                proofHash: bytes32(0),
                submittedAt: 0,
                approvedAt: 0,
                status: MilestoneStatus.PENDING
            });
        }
        _safeTransferFrom(msg.sender, address(this), totalAmount);
        emit PlanCreated(planId, msg.sender, agent, totalAmount, amounts.length);
    }

    function submitProof(uint256 planId, uint256 milestoneId, bytes32 proofHash) external {
        Plan storage plan = plans[planId];
        if (!plan.active) revert PlanInactive();
        if (msg.sender != plan.agent) revert Unauthorized();
        _validateMilestone(planId, milestoneId);
        Milestone storage milestone = milestones[planId][milestoneId];
        if (milestone.status != MilestoneStatus.PENDING) revert InvalidState(milestone.status);
        if (proofHash == bytes32(0)) revert EmptyProof();

        milestone.proofHash = proofHash;
        milestone.submittedAt = uint64(block.timestamp);
        milestone.status = MilestoneStatus.PROOF_SUBMITTED;
        emit ProofSubmitted(planId, milestoneId, proofHash);
    }

    function rejectProof(uint256 planId, uint256 milestoneId) external {
        Plan storage plan = plans[planId];
        if (!plan.active) revert PlanInactive();
        if (msg.sender != plan.creator) revert Unauthorized();
        _validateMilestone(planId, milestoneId);
        Milestone storage milestone = milestones[planId][milestoneId];
        if (milestone.status != MilestoneStatus.PROOF_SUBMITTED) revert InvalidState(milestone.status);
        milestone.status = MilestoneStatus.PENDING;
        emit ProofRejected(planId, milestoneId, milestone.proofHash);
    }

    function approveMilestone(uint256 planId, uint256 milestoneId) external {
        Plan storage plan = plans[planId];
        if (!plan.active) revert PlanInactive();
        if (msg.sender != plan.creator) revert Unauthorized();
        _validateMilestone(planId, milestoneId);
        Milestone storage milestone = milestones[planId][milestoneId];
        if (milestone.status != MilestoneStatus.PROOF_SUBMITTED) revert InvalidState(milestone.status);
        milestone.approvedAt = uint64(block.timestamp);
        milestone.status = MilestoneStatus.APPROVED;
        emit MilestoneApproved(planId, milestoneId, milestone.amount);
    }

    function claimMilestone(uint256 planId, uint256 milestoneId) external {
        Plan storage plan = plans[planId];
        if (!plan.active) revert PlanInactive();
        if (msg.sender != plan.agent) revert Unauthorized();
        _validateMilestone(planId, milestoneId);
        Milestone storage milestone = milestones[planId][milestoneId];
        if (milestone.status != MilestoneStatus.APPROVED) revert InvalidState(milestone.status);

        milestone.status = MilestoneStatus.CLAIMED;
        plan.claimedAmount += milestone.amount;
        if (plan.claimedAmount == plan.totalAmount) plan.active = false;
        if (!_safeTransfer(plan.agent, milestone.amount)) revert TransferFailed();
        emit MilestoneClaimed(planId, milestoneId, plan.agent, milestone.amount, milestone.proofHash);
    }

    function cancelPlan(uint256 planId) external {
        Plan storage plan = plans[planId];
        if (!plan.active) revert PlanInactive();
        if (msg.sender != plan.creator) revert Unauthorized();

        for (uint256 i = 0; i < plan.milestoneCount; ++i) {
            if (milestones[planId][i].status == MilestoneStatus.APPROVED) {
                revert ApprovedMilestonePending();
            }
        }

        uint256 refund = plan.totalAmount - plan.claimedAmount;
        plan.active = false;
        if (refund != 0 && !_safeTransfer(plan.creator, refund)) revert TransferFailed();
        emit PlanCancelled(planId, refund);
    }

    function _validateMilestone(uint256 planId, uint256 milestoneId) private view {
        Plan storage plan = plans[planId];
        if (milestoneId >= plan.milestoneCount) revert InvalidMilestone();
    }

    function _safeTransfer(address to, uint256 amount) private returns (bool) {
        (bool success, bytes memory result) = address(usdc).call(
            abi.encodeCall(IMilestoneERC20.transfer, (to, amount))
        );
        return success && (result.length == 0 || abi.decode(result, (bool)));
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool success, bytes memory result) = address(usdc).call(
            abi.encodeCall(IMilestoneERC20.transferFrom, (from, to, amount))
        );
        if (!success || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }
}
