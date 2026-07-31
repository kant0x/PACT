// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PACT GIWA Agent Registry
/// @notice Stores agent-controlled profile hashes and immutable task receipts on GIWA.
/// @dev No personal or task content is stored on-chain.
contract PACTGiwaRegistry {
    error Unauthorized();
    error ZeroAddress();
    error EmptyValue();
    error AgentNotRegistered();
    error TaskAlreadyRecorded(bytes32 taskId);

    struct AgentProfile {
        bytes32 profileHash;
        uint64 registeredAt;
        uint64 updatedAt;
        uint64 completedTasks;
        uint64 successfulTasks;
        uint256 reputationPoints;
    }

    struct TaskReceipt {
        address agent;
        address issuer;
        bytes32 evidenceHash;
        uint64 recordedAt;
        bool successful;
        uint256 points;
    }

    address public owner;
    mapping(address => bool) public authorizedIssuers;
    mapping(address => AgentProfile) private profiles;
    mapping(bytes32 => TaskReceipt) private taskReceipts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event IssuerAuthorizationUpdated(address indexed issuer, bool authorized);
    event AgentRegistered(address indexed agent, bytes32 indexed profileHash);
    event AgentProfileUpdated(address indexed agent, bytes32 indexed profileHash);
    event TaskRecorded(bytes32 indexed taskId, address indexed agent, address indexed issuer, bool successful, uint256 points, bytes32 evidenceHash);

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
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
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setIssuer(address issuer, bool authorized) external onlyOwner {
        if (issuer == address(0)) revert ZeroAddress();
        authorizedIssuers[issuer] = authorized;
        emit IssuerAuthorizationUpdated(issuer, authorized);
    }

    function registerAgent(bytes32 profileHash) external {
        if (profileHash == bytes32(0)) revert EmptyValue();
        AgentProfile storage profile = profiles[msg.sender];
        if (profile.registeredAt == 0) {
            uint64 timestamp = uint64(block.timestamp);
            profile.profileHash = profileHash;
            profile.registeredAt = timestamp;
            profile.updatedAt = timestamp;
            emit AgentRegistered(msg.sender, profileHash);
            return;
        }
        profile.profileHash = profileHash;
        profile.updatedAt = uint64(block.timestamp);
        emit AgentProfileUpdated(msg.sender, profileHash);
    }

    function recordTask(address agent, bytes32 taskId, bool successful, uint256 points, bytes32 evidenceHash) external onlyIssuer {
        if (agent == address(0)) revert ZeroAddress();
        if (taskId == bytes32(0) || evidenceHash == bytes32(0)) revert EmptyValue();
        AgentProfile storage profile = profiles[agent];
        if (profile.registeredAt == 0) revert AgentNotRegistered();
        if (taskReceipts[taskId].recordedAt != 0) revert TaskAlreadyRecorded(taskId);

        taskReceipts[taskId] = TaskReceipt({
            agent: agent,
            issuer: msg.sender,
            evidenceHash: evidenceHash,
            recordedAt: uint64(block.timestamp),
            successful: successful,
            points: points
        });
        profile.completedTasks += 1;
        if (successful) profile.successfulTasks += 1;
        profile.reputationPoints += points;
        profile.updatedAt = uint64(block.timestamp);
        emit TaskRecorded(taskId, agent, msg.sender, successful, points, evidenceHash);
    }

    function getAgent(address agent) external view returns (AgentProfile memory) {
        return profiles[agent];
    }

    function getTaskReceipt(bytes32 taskId) external view returns (TaskReceipt memory) {
        return taskReceipts[taskId];
    }
}
