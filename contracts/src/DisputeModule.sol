// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IStreamingVaultSettlement {
    function slashCollateral(uint256 taskId, uint256 slashPct) external;
    function resumeAfterDispute(uint256 taskId) external;
}

interface IVerificationRegistry {
    function isAcceptedVerdict(address vault, uint256 taskId, bytes32 verdictHash) external view returns (bool);
}

/// @notice Controlled settlement relay for finalized PACT dispute decisions.
/// @dev The off-chain Judge decides the fault classification. This contract
/// only applies an already-finalized slash policy to the configured vault.
contract DisputeModule {
    error Unauthorized();
    error ZeroAddress();
    error InvalidPercentage();
    error InvalidDecisionHash();
    error DecisionAlreadyExecuted();
    error VaultNotConfigured();
    error ModulePaused();
    error ReentrantCall();
    error VerdictNotVerified();

    address public owner;
    address public vault;
    address public verificationRegistry;
    bool public paused;
    bool private executing;
    mapping(bytes32 => bool) public executedDecisions;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event VaultConfigured(address indexed previousVault, address indexed newVault);
    event VerificationRegistryConfigured(address indexed previousRegistry, address indexed newRegistry);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event DecisionSettled(
        bytes32 indexed decisionHash,
        uint256 indexed taskId,
        uint256 slashPct,
        address indexed operator
    );

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier nonReentrant() {
        if (executing) revert ReentrantCall();
        executing = true;
        _;
        executing = false;
    }

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setVault(address newVault) external onlyOwner {
        if (newVault == address(0)) revert ZeroAddress();
        emit VaultConfigured(vault, newVault);
        vault = newVault;
    }

    /// @notice Enables verifier-gated settlement. An independent authorized
    /// verifier must first confirm the report and off-chain Judge verdict.
    function setVerificationRegistry(address newRegistry) external onlyOwner {
        if (newRegistry == address(0)) revert ZeroAddress();
        emit VerificationRegistryConfigured(verificationRegistry, newRegistry);
        verificationRegistry = newRegistry;
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    /// @notice Apply a finalized settlement decision exactly once.
    /// @param decisionHash Hash of the immutable Judge/settlement receipt.
    function settle(
        uint256 taskId,
        uint256 slashPct,
        bytes32 decisionHash
    ) external onlyOwner nonReentrant {
        if (paused) revert ModulePaused();
        if (vault == address(0)) revert VaultNotConfigured();
        if (slashPct > 100) revert InvalidPercentage();
        if (decisionHash == bytes32(0)) revert InvalidDecisionHash();
        if (executedDecisions[decisionHash]) revert DecisionAlreadyExecuted();
        if (
            verificationRegistry != address(0)
            && !IVerificationRegistry(verificationRegistry).isAcceptedVerdict(vault, taskId, decisionHash)
        ) revert VerdictNotVerified();

        executedDecisions[decisionHash] = true;
        if (slashPct == 0) {
            IStreamingVaultSettlement(vault).resumeAfterDispute(taskId);
        } else {
            IStreamingVaultSettlement(vault).slashCollateral(taskId, slashPct);
        }
        emit DecisionSettled(decisionHash, taskId, slashPct, msg.sender);
    }
}
