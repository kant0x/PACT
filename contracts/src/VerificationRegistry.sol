// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IWorkOrderCommitmentsRead {
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
        );
}

/// @notice Independent verifier attestations for a submitted work-order report.
/// @dev AI Judge scoring remains off-chain. A verifier records only the final
/// verdict hash and evidence hash, which may later drive points, rewards, or
/// reputation through an authorized integration.
contract VerificationRegistry {
    struct Verification {
        address verifier;
        bytes32 reportHash;
        bytes32 verdictHash;
        bytes32 evidenceHash;
        bool accepted;
        uint64 verifiedAt;
    }

    address public owner;
    IWorkOrderCommitmentsRead public immutable workOrderCommitments;
    mapping(address => bool) public authorizedVerifiers;
    mapping(address => mapping(uint256 => mapping(address => Verification))) private verifications;
    mapping(address => mapping(uint256 => mapping(bytes32 => bool))) private acceptedVerdicts;

    error Unauthorized();
    error ZeroAddress();
    error EmptyHash();
    error AlreadyVerified();
    error ReportNotAnchored();

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AuthorizedVerifierUpdated(address indexed verifier, bool authorized);
    event ResultVerified(
        address indexed vault,
        uint256 indexed taskId,
        address indexed verifier,
        bytes32 reportHash,
        bytes32 verdictHash,
        bytes32 evidenceHash,
        bool accepted,
        uint256 timestamp
    );

    constructor(address initialOwner, address workOrderCommitmentsAddress) {
        if (initialOwner == address(0) || workOrderCommitmentsAddress == address(0)) revert ZeroAddress();
        owner = initialOwner;
        workOrderCommitments = IWorkOrderCommitmentsRead(workOrderCommitmentsAddress);
        emit OwnershipTransferred(address(0), initialOwner);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyAuthorizedVerifier() {
        if (!authorizedVerifiers[msg.sender]) revert Unauthorized();
        _;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setAuthorizedVerifier(address verifier, bool authorized) external onlyOwner {
        if (verifier == address(0)) revert ZeroAddress();
        authorizedVerifiers[verifier] = authorized;
        emit AuthorizedVerifierUpdated(verifier, authorized);
    }

    function verifyResult(
        address vault,
        uint256 taskId,
        bytes32 reportHash,
        bytes32 verdictHash,
        bytes32 evidenceHash,
        bool accepted
    ) external onlyAuthorizedVerifier {
        if (vault == address(0)) revert ZeroAddress();
        if (reportHash == bytes32(0) || verdictHash == bytes32(0) || evidenceHash == bytes32(0)) revert EmptyHash();
        (, , , , bytes32 anchoredReportHash, , ) = workOrderCommitments.getWorkOrderCommitment(vault, taskId);
        if (anchoredReportHash != reportHash) revert ReportNotAnchored();
        Verification storage verification = verifications[vault][taskId][msg.sender];
        if (verification.verifiedAt != 0) revert AlreadyVerified();
        verifications[vault][taskId][msg.sender] = Verification({
            verifier: msg.sender,
            reportHash: reportHash,
            verdictHash: verdictHash,
            evidenceHash: evidenceHash,
            accepted: accepted,
            verifiedAt: uint64(block.timestamp)
        });
        if (accepted) acceptedVerdicts[vault][taskId][verdictHash] = true;
        emit ResultVerified(vault, taskId, msg.sender, reportHash, verdictHash, evidenceHash, accepted, block.timestamp);
    }

    function getVerification(address vault, uint256 taskId, address verifier) external view returns (Verification memory) {
        return verifications[vault][taskId][verifier];
    }

    function isAcceptedVerdict(address vault, uint256 taskId, bytes32 verdictHash) external view returns (bool) {
        return acceptedVerdicts[vault][taskId][verdictHash];
    }
}
