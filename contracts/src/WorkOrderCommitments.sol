// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Immutable commitments for funded PACT work orders.
/// @dev Briefs, acceptance criteria, and report packets remain off-chain.
/// Their hashes and lifecycle receipts are public, so neither party can swap
/// a document after the USDC order has been funded.
contract WorkOrderCommitments {
    struct WorkOrderCommitment {
        address creator;
        address agent;
        bytes32 termsHash;
        bytes32 acceptanceChecklistHash;
        bytes32 reportHash;
        uint64 committedAt;
        uint64 reportedAt;
    }

    address public owner;
    mapping(address => bool) public authorizedWriters;
    mapping(address => mapping(uint256 => WorkOrderCommitment)) private commitments;

    error Unauthorized();
    error ZeroAddress();
    error EmptyHash();
    error WorkOrderAlreadyCommitted();
    error WorkOrderNotCommitted();
    error ReportAlreadyCommitted();

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AuthorizedWriterUpdated(address indexed writer, bool authorized);
    event WorkOrderCommitted(
        address indexed vault,
        uint256 indexed taskId,
        address indexed creator,
        bytes32 termsHash,
        bytes32 acceptanceChecklistHash,
        uint256 timestamp
    );
    event ReportCommitted(
        address indexed vault,
        uint256 indexed taskId,
        address indexed agent,
        bytes32 reportHash,
        uint256 timestamp
    );

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyAuthorizedWriter() {
        if (!authorizedWriters[msg.sender]) revert Unauthorized();
        _;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setAuthorizedWriter(address writer, bool authorized) external onlyOwner {
        if (writer == address(0)) revert ZeroAddress();
        authorizedWriters[writer] = authorized;
        emit AuthorizedWriterUpdated(writer, authorized);
    }

    function createWorkOrderCommitment(
        uint256 taskId,
        address creator,
        bytes32 termsHash,
        bytes32 acceptanceChecklistHash
    ) external onlyAuthorizedWriter {
        if (creator == address(0)) revert ZeroAddress();
        if (termsHash == bytes32(0) || acceptanceChecklistHash == bytes32(0)) revert EmptyHash();
        WorkOrderCommitment storage commitment = commitments[msg.sender][taskId];
        if (commitment.committedAt != 0) revert WorkOrderAlreadyCommitted();
        commitment.creator = creator;
        commitment.termsHash = termsHash;
        commitment.acceptanceChecklistHash = acceptanceChecklistHash;
        commitment.committedAt = uint64(block.timestamp);
        emit WorkOrderCommitted(msg.sender, taskId, creator, termsHash, acceptanceChecklistHash, block.timestamp);
    }

    function recordReport(uint256 taskId, address agent, bytes32 reportHash) external onlyAuthorizedWriter {
        if (agent == address(0)) revert ZeroAddress();
        if (reportHash == bytes32(0)) revert EmptyHash();
        WorkOrderCommitment storage commitment = commitments[msg.sender][taskId];
        if (commitment.committedAt == 0) revert WorkOrderNotCommitted();
        if (commitment.reportHash != bytes32(0)) revert ReportAlreadyCommitted();
        commitment.agent = agent;
        commitment.reportHash = reportHash;
        commitment.reportedAt = uint64(block.timestamp);
        emit ReportCommitted(msg.sender, taskId, agent, reportHash, block.timestamp);
    }

    function getWorkOrderCommitment(address vault, uint256 taskId)
        external
        view
        returns (
            address creator,
            address agent,
            bytes32 termsHash,
            bytes32 acceptanceChecklistHash,
            bytes32 reportHash,
            uint64 committedAt,
            uint64 reportedAt
        )
    {
        WorkOrderCommitment storage commitment = commitments[vault][taskId];
        return (
            commitment.creator,
            commitment.agent,
            commitment.termsHash,
            commitment.acceptanceChecklistHash,
            commitment.reportHash,
            commitment.committedAt,
            commitment.reportedAt
        );
    }

    function hasWorkOrderCommitment(address vault, uint256 taskId) external view returns (bool) {
        return commitments[vault][taskId].committedAt != 0;
    }
}
