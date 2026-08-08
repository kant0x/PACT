// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Self-owned on-chain identity anchor for PACT agents.
/// @dev Profile and capability documents stay off-chain. Their hashes make the
///      published version and wallet ownership independently verifiable.
contract AgentRegistry {
    struct AgentProfile {
        bytes32 profileHash;
        bytes32 capabilitiesHash;
        uint64 registeredAt;
        uint64 updatedAt;
        bool active;
    }

    mapping(address => AgentProfile) private profiles;

    error AgentAlreadyRegistered();
    error AgentNotRegistered();
    error EmptyHash();

    event AgentRegistered(
        address indexed agent,
        bytes32 indexed profileHash,
        bytes32 indexed capabilitiesHash,
        uint256 timestamp
    );
    event AgentProfileUpdated(
        address indexed agent,
        bytes32 indexed profileHash,
        bytes32 indexed capabilitiesHash,
        uint256 timestamp
    );
    event AgentStatusUpdated(address indexed agent, bool active, uint256 timestamp);

    function registerAgent(bytes32 profileHash, bytes32 capabilitiesHash) external {
        if (profiles[msg.sender].registeredAt != 0) revert AgentAlreadyRegistered();
        _requireHashes(profileHash, capabilitiesHash);
        profiles[msg.sender] = AgentProfile({
            profileHash: profileHash,
            capabilitiesHash: capabilitiesHash,
            registeredAt: uint64(block.timestamp),
            updatedAt: uint64(block.timestamp),
            active: true
        });
        emit AgentRegistered(msg.sender, profileHash, capabilitiesHash, block.timestamp);
    }

    function updateAgentProfile(bytes32 profileHash, bytes32 capabilitiesHash) external {
        AgentProfile storage profile = profiles[msg.sender];
        if (profile.registeredAt == 0) revert AgentNotRegistered();
        _requireHashes(profileHash, capabilitiesHash);
        profile.profileHash = profileHash;
        profile.capabilitiesHash = capabilitiesHash;
        profile.updatedAt = uint64(block.timestamp);
        emit AgentProfileUpdated(msg.sender, profileHash, capabilitiesHash, block.timestamp);
    }

    function setAgentActive(bool active) external {
        AgentProfile storage profile = profiles[msg.sender];
        if (profile.registeredAt == 0) revert AgentNotRegistered();
        profile.active = active;
        profile.updatedAt = uint64(block.timestamp);
        emit AgentStatusUpdated(msg.sender, active, block.timestamp);
    }

    function isRegistered(address agent) external view returns (bool) {
        return profiles[agent].registeredAt != 0;
    }

    function getAgentProfile(address agent)
        external
        view
        returns (
            bytes32 profileHash,
            bytes32 capabilitiesHash,
            uint64 registeredAt,
            uint64 updatedAt,
            bool active
        )
    {
        AgentProfile storage profile = profiles[agent];
        return (
            profile.profileHash,
            profile.capabilitiesHash,
            profile.registeredAt,
            profile.updatedAt,
            profile.active
        );
    }

    function _requireHashes(bytes32 profileHash, bytes32 capabilitiesHash) private pure {
        if (profileHash == bytes32(0) || capabilitiesHash == bytes32(0)) revert EmptyHash();
    }
}
