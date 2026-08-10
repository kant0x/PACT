// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Versioned public specification registry for PACT Hubs.
/// @dev A Hub's detailed policy stays off-chain; each published version commits
/// its rules, limits, and task-specification documents by hash.
contract HubRegistry {
    struct HubVersion {
        bytes32 rulesHash;
        bytes32 limitsHash;
        bytes32 taskSpecHash;
        uint64 publishedAt;
        bool active;
    }

    address public owner;
    mapping(bytes32 => HubVersion[]) private versions;

    error Unauthorized();
    error ZeroHash();
    error UnknownVersion();

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event HubVersionPublished(
        bytes32 indexed hubId,
        uint256 indexed version,
        bytes32 rulesHash,
        bytes32 limitsHash,
        bytes32 taskSpecHash,
        bool active,
        uint256 timestamp
    );
    event HubVersionStatusUpdated(bytes32 indexed hubId, uint256 indexed version, bool active, uint256 timestamp);

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert Unauthorized();
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert Unauthorized();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function publishHubVersion(
        bytes32 hubId,
        bytes32 rulesHash,
        bytes32 limitsHash,
        bytes32 taskSpecHash,
        bool active
    ) external onlyOwner returns (uint256 version) {
        if (hubId == bytes32(0) || rulesHash == bytes32(0) || limitsHash == bytes32(0) || taskSpecHash == bytes32(0)) {
            revert ZeroHash();
        }
        versions[hubId].push(HubVersion({
            rulesHash: rulesHash,
            limitsHash: limitsHash,
            taskSpecHash: taskSpecHash,
            publishedAt: uint64(block.timestamp),
            active: active
        }));
        version = versions[hubId].length;
        emit HubVersionPublished(hubId, version, rulesHash, limitsHash, taskSpecHash, active, block.timestamp);
    }

    function setHubVersionActive(bytes32 hubId, uint256 version, bool active) external onlyOwner {
        if (version == 0 || version > versions[hubId].length) revert UnknownVersion();
        versions[hubId][version - 1].active = active;
        emit HubVersionStatusUpdated(hubId, version, active, block.timestamp);
    }

    function hubVersionCount(bytes32 hubId) external view returns (uint256) {
        return versions[hubId].length;
    }

    function getHubVersion(bytes32 hubId, uint256 version) external view returns (HubVersion memory) {
        if (version == 0 || version > versions[hubId].length) revert UnknownVersion();
        return versions[hubId][version - 1];
    }
}
