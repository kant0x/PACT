// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IRewardERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice Pre-funded USDC rewards that an agent must claim from its own wallet.
/// @dev This is intentionally separate from PlatformPoints: points have no cash
///      value, while this vault transfers real USDC to an agent's Circle wallet.
contract RewardVault {
    struct Reward {
        address funder;
        address agent;
        uint256 amount;
        bytes32 proofHash;
        bool claimed;
        bool cancelled;
    }

    IRewardERC20 public immutable usdc;
    address public owner;
    uint256 public nextRewardId = 1;
    mapping(address => bool) public authorizedIssuers;
    mapping(uint256 => Reward) public rewards;

    error Unauthorized();
    error InvalidAmount();
    error EmptyProof();
    error InvalidState();
    error TransferFailed();

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AuthorizedIssuerUpdated(address indexed issuer, bool authorized);
    event RewardCreated(
        uint256 indexed rewardId,
        address indexed funder,
        address indexed agent,
        uint256 amount,
        bytes32 proofHash
    );
    event RewardClaimed(uint256 indexed rewardId, address indexed agent, uint256 amount);
    event RewardCancelled(uint256 indexed rewardId, address indexed funder, uint256 amount);

    constructor(address usdcAddress, address initialOwner) {
        if (usdcAddress == address(0) || initialOwner == address(0)) revert InvalidAmount();
        usdc = IRewardERC20(usdcAddress);
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyIssuer() {
        if (!authorizedIssuers[msg.sender]) revert Unauthorized();
        _;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAmount();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setAuthorizedIssuer(address issuer, bool authorized) external onlyOwner {
        if (issuer == address(0)) revert InvalidAmount();
        authorizedIssuers[issuer] = authorized;
        emit AuthorizedIssuerUpdated(issuer, authorized);
    }

    function createReward(address agent, uint256 amount, bytes32 proofHash)
        external
        onlyIssuer
        returns (uint256 rewardId)
    {
        if (agent == address(0) || amount == 0) revert InvalidAmount();
        if (proofHash == bytes32(0)) revert EmptyProof();
        rewardId = nextRewardId++;
        rewards[rewardId] = Reward({
            funder: msg.sender,
            agent: agent,
            amount: amount,
            proofHash: proofHash,
            claimed: false,
            cancelled: false
        });
        _safeTransferFrom(msg.sender, address(this), amount);
        emit RewardCreated(rewardId, msg.sender, agent, amount, proofHash);
    }

    function claimReward(uint256 rewardId) external {
        Reward storage reward = rewards[rewardId];
        if (reward.claimed || reward.cancelled) revert InvalidState();
        if (msg.sender != reward.agent) revert Unauthorized();
        reward.claimed = true;
        _safeTransfer(reward.agent, reward.amount);
        emit RewardClaimed(rewardId, reward.agent, reward.amount);
    }

    function cancelReward(uint256 rewardId) external {
        Reward storage reward = rewards[rewardId];
        if (reward.claimed || reward.cancelled) revert InvalidState();
        if (msg.sender != reward.funder && msg.sender != owner) revert Unauthorized();
        reward.cancelled = true;
        _safeTransfer(reward.funder, reward.amount);
        emit RewardCancelled(rewardId, reward.funder, reward.amount);
    }

    function _safeTransfer(address to, uint256 amount) private {
        (bool success, bytes memory result) = address(usdc).call(
            abi.encodeCall(IRewardERC20.transfer, (to, amount))
        );
        if (!success || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool success, bytes memory result) = address(usdc).call(
            abi.encodeCall(IRewardERC20.transferFrom, (from, to, amount))
        );
        if (!success || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }
}
