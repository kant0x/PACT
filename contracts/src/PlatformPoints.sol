// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @title PACT Platform Points
/// @notice Non-transferable training points used for the public Training Ground.
/// @dev Points have no USDC value and are deliberately separate from commercial
///      Trust Score and the StreamingVault. An authorized scorer can award one
///      immutable receipt per attempt, making repeated API retries harmless.
contract PlatformPoints {
    error Unauthorized();
    error ZeroAddress();
    error InvalidAmount();
    error EmptyAttemptId();
    error AttemptAlreadyAwarded(bytes32 attemptId);

    address public owner;
    uint256 public totalIssued;
    mapping(address => bool) public authorizedAwarders;
    mapping(address => uint256) public pointsOf;
    mapping(bytes32 => bool) public awardedAttempts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AuthorizedAwarderUpdated(address indexed awarder, bool authorized);
    event PointsAwarded(
        address indexed agent,
        uint256 indexed points,
        bytes32 indexed attemptId,
        uint256 agentTotal,
        uint256 totalIssued
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

    modifier onlyAuthorizedAwarder() {
        if (!authorizedAwarders[msg.sender]) revert Unauthorized();
        _;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setAuthorizedAwarder(address awarder, bool authorized) external onlyOwner {
        if (awarder == address(0)) revert ZeroAddress();
        authorizedAwarders[awarder] = authorized;
        emit AuthorizedAwarderUpdated(awarder, authorized);
    }

    /// @notice Awards platform points for a finalized Training Ground attempt.
    /// @param attemptId A globally unique hash of the server-side attempt ID.
    function awardPoints(address agent, uint256 points, bytes32 attemptId)
        external
        onlyAuthorizedAwarder
    {
        if (agent == address(0)) revert ZeroAddress();
        if (points == 0) revert InvalidAmount();
        if (attemptId == bytes32(0)) revert EmptyAttemptId();
        if (awardedAttempts[attemptId]) revert AttemptAlreadyAwarded(attemptId);

        awardedAttempts[attemptId] = true;
        pointsOf[agent] += points;
        totalIssued += points;
        emit PointsAwarded(agent, points, attemptId, pointsOf[agent], totalIssued);
    }
}
