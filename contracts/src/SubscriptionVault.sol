// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISubscriptionERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice Pre-funded recurring work allowance with agent-initiated claims.
/// @dev A claim records a proof hash and pays the configured Circle/EOA agent
///      directly. The creator can cancel future periods at any time.
contract SubscriptionVault {
    struct Subscription {
        address creator;
        address agent;
        uint256 periodAmount;
        uint64 periodSeconds;
        uint32 totalPeriods;
        uint32 claimedPeriods;
        uint64 nextClaimAt;
        bool active;
    }

    struct PeriodClaim {
        bytes32 proofHash;
        uint64 claimedAt;
        uint256 amount;
    }

    ISubscriptionERC20 public immutable usdc;
    uint256 public nextSubscriptionId = 1;
    mapping(uint256 => Subscription) public subscriptions;
    mapping(uint256 => mapping(uint256 => PeriodClaim)) public periodClaims;

    error Unauthorized();
    error InvalidAmount();
    error InvalidPeriods();
    error InvalidState();
    error NotDue();
    error EmptyProof();
    error TransferFailed();

    event SubscriptionCreated(
        uint256 indexed subscriptionId,
        address indexed creator,
        address indexed agent,
        uint256 periodAmount,
        uint256 periodSeconds,
        uint256 totalPeriods,
        uint256 firstClaimAt
    );
    event PeriodClaimed(
        uint256 indexed subscriptionId,
        uint256 indexed period,
        address indexed agent,
        uint256 amount,
        bytes32 proofHash
    );
    event SubscriptionCancelled(uint256 indexed subscriptionId, uint256 refundedAmount);

    constructor(address usdcAddress) {
        if (usdcAddress == address(0)) revert InvalidAmount();
        usdc = ISubscriptionERC20(usdcAddress);
    }

    function createSubscription(
        address agent,
        uint256 periodAmount,
        uint64 periodSeconds,
        uint32 totalPeriods
    ) external returns (uint256 subscriptionId) {
        if (agent == address(0) || periodAmount == 0) revert InvalidAmount();
        if (periodSeconds == 0 || totalPeriods == 0) revert InvalidPeriods();
        uint256 totalAmount = periodAmount * totalPeriods;
        subscriptionId = nextSubscriptionId++;
        uint64 firstClaimAt = uint64(block.timestamp + periodSeconds);
        subscriptions[subscriptionId] = Subscription({
            creator: msg.sender,
            agent: agent,
            periodAmount: periodAmount,
            periodSeconds: periodSeconds,
            totalPeriods: totalPeriods,
            claimedPeriods: 0,
            nextClaimAt: firstClaimAt,
            active: true
        });
        _safeTransferFrom(msg.sender, address(this), totalAmount);
        emit SubscriptionCreated(
            subscriptionId,
            msg.sender,
            agent,
            periodAmount,
            periodSeconds,
            totalPeriods,
            firstClaimAt
        );
    }

    function claimPeriod(uint256 subscriptionId, bytes32 proofHash) external {
        Subscription storage subscription = subscriptions[subscriptionId];
        if (!subscription.active || subscription.claimedPeriods >= subscription.totalPeriods) {
            revert InvalidState();
        }
        if (msg.sender != subscription.agent) revert Unauthorized();
        if (block.timestamp < subscription.nextClaimAt) revert NotDue();
        if (proofHash == bytes32(0)) revert EmptyProof();

        uint256 period = subscription.claimedPeriods;
        periodClaims[subscriptionId][period] = PeriodClaim({
            proofHash: proofHash,
            claimedAt: uint64(block.timestamp),
            amount: subscription.periodAmount
        });
        subscription.claimedPeriods += 1;
        subscription.nextClaimAt += subscription.periodSeconds;
        if (subscription.claimedPeriods == subscription.totalPeriods) subscription.active = false;
        _safeTransfer(subscription.agent, subscription.periodAmount);
        emit PeriodClaimed(subscriptionId, period, subscription.agent, subscription.periodAmount, proofHash);
    }

    function cancelSubscription(uint256 subscriptionId) external {
        Subscription storage subscription = subscriptions[subscriptionId];
        if (!subscription.active) revert InvalidState();
        if (msg.sender != subscription.creator) revert Unauthorized();

        uint256 remainingPeriods = subscription.totalPeriods - subscription.claimedPeriods;
        uint256 refund = subscription.periodAmount * remainingPeriods;
        subscription.active = false;
        if (refund != 0) _safeTransfer(subscription.creator, refund);
        emit SubscriptionCancelled(subscriptionId, refund);
    }

    function _safeTransfer(address to, uint256 amount) private {
        (bool success, bytes memory result) = address(usdc).call(
            abi.encodeCall(ISubscriptionERC20.transfer, (to, amount))
        );
        if (!success || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool success, bytes memory result) = address(usdc).call(
            abi.encodeCall(ISubscriptionERC20.transferFrom, (from, to, amount))
        );
        if (!success || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }
}
