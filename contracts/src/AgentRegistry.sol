// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Self-owned on-chain identity anchor for PACT agents.
/// @dev Profile and capability documents stay off-chain. Their hashes make the
///      published version and wallet ownership independently verifiable.
contract AgentRegistry {
    enum AgentActivityType {
        TRAINING_STARTED,
        TRAINING_PAUSED,
        TRAINING_RESTARTED
    }

    struct AgentProfile {
        bytes32 profileHash;
        bytes32 capabilitiesHash;
        uint64 registeredAt;
        uint64 updatedAt;
        bool active;
    }

    /// @notice Full agent envelope is kept off-chain; this structure anchors
    /// the controller and hashes of every registered document on-chain.
    struct AgentCommitment {
        address controller;
        bytes32 documentHash;
        bytes32 walletPolicyHash;
        bytes32 runtimeHash;
        uint64 committedAt;
        uint64 updatedAt;
    }

    mapping(address => AgentProfile) private profiles;
    mapping(address => AgentCommitment) private commitments;

    error AgentAlreadyRegistered();
    error AgentNotRegistered();
    error EmptyHash();
    error InvalidController();

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
    event AgentRegisteredWithCommitment(
        address indexed agent,
        address indexed controller,
        bytes32 indexed documentHash,
        bytes32 profileHash,
        bytes32 capabilitiesHash,
        bytes32 walletPolicyHash,
        bytes32 runtimeHash,
        uint256 timestamp
    );
    event AgentCommitmentUpdated(
        address indexed agent,
        bytes32 indexed documentHash,
        bytes32 walletPolicyHash,
        bytes32 runtimeHash,
        uint256 timestamp
    );
    event AgentActivityRecorded(
        address indexed agent,
        uint8 indexed activityType,
        bytes32 indexed detailsHash,
        uint256 timestamp
    );

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

    /// @notice Registers an agent and commits its complete signed registration
    /// envelope. The Circle smart account itself calls this method, so no
    /// platform operator can create or alter an agent identity unilaterally.
    function registerAgentWithCommitment(
        bytes32 profileHash,
        bytes32 capabilitiesHash,
        bytes32 documentHash,
        bytes32 walletPolicyHash,
        bytes32 runtimeHash,
        address controller
    ) external {
        if (profiles[msg.sender].registeredAt != 0) revert AgentAlreadyRegistered();
        _requireHashes(profileHash, capabilitiesHash);
        _requireCommitment(documentHash, walletPolicyHash, runtimeHash, controller);

        profiles[msg.sender] = AgentProfile({
            profileHash: profileHash,
            capabilitiesHash: capabilitiesHash,
            registeredAt: uint64(block.timestamp),
            updatedAt: uint64(block.timestamp),
            active: true
        });
        commitments[msg.sender] = AgentCommitment({
            controller: controller,
            documentHash: documentHash,
            walletPolicyHash: walletPolicyHash,
            runtimeHash: runtimeHash,
            committedAt: uint64(block.timestamp),
            updatedAt: uint64(block.timestamp)
        });

        emit AgentRegistered(msg.sender, profileHash, capabilitiesHash, block.timestamp);
        emit AgentRegisteredWithCommitment(
            msg.sender,
            controller,
            documentHash,
            profileHash,
            capabilitiesHash,
            walletPolicyHash,
            runtimeHash,
            block.timestamp
        );
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

    /// @notice Lets legacy agents add the full document commitment without
    /// replacing their original profile or changing the agent address.
    function commitAgentDocument(
        bytes32 documentHash,
        bytes32 walletPolicyHash,
        bytes32 runtimeHash,
        address controller
    ) external {
        if (profiles[msg.sender].registeredAt == 0) revert AgentNotRegistered();
        _requireCommitment(documentHash, walletPolicyHash, runtimeHash, controller);
        AgentCommitment storage commitment = commitments[msg.sender];
        commitment.controller = controller;
        commitment.documentHash = documentHash;
        commitment.walletPolicyHash = walletPolicyHash;
        commitment.runtimeHash = runtimeHash;
        if (commitment.committedAt == 0) commitment.committedAt = uint64(block.timestamp);
        commitment.updatedAt = uint64(block.timestamp);
        emit AgentCommitmentUpdated(msg.sender, documentHash, walletPolicyHash, runtimeHash, block.timestamp);
    }

    /// @notice Durable on-chain lifecycle receipt for start, pause, and restart
    /// actions. Details are hashed so no runtime credential or private prompt is
    /// placed into a public event log.
    function recordActivity(AgentActivityType activityType, bytes32 detailsHash) external {
        if (profiles[msg.sender].registeredAt == 0) revert AgentNotRegistered();
        if (detailsHash == bytes32(0)) revert EmptyHash();
        emit AgentActivityRecorded(msg.sender, uint8(activityType), detailsHash, block.timestamp);
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

    function getAgentCommitment(address agent)
        external
        view
        returns (
            address controller,
            bytes32 documentHash,
            bytes32 walletPolicyHash,
            bytes32 runtimeHash,
            uint64 committedAt,
            uint64 updatedAt
        )
    {
        AgentCommitment storage commitment = commitments[agent];
        return (
            commitment.controller,
            commitment.documentHash,
            commitment.walletPolicyHash,
            commitment.runtimeHash,
            commitment.committedAt,
            commitment.updatedAt
        );
    }

    function _requireHashes(bytes32 profileHash, bytes32 capabilitiesHash) private pure {
        if (profileHash == bytes32(0) || capabilitiesHash == bytes32(0)) revert EmptyHash();
    }

    function _requireCommitment(
        bytes32 documentHash,
        bytes32 walletPolicyHash,
        bytes32 runtimeHash,
        address controller
    ) private pure {
        if (controller == address(0)) revert InvalidController();
        if (documentHash == bytes32(0) || walletPolicyHash == bytes32(0) || runtimeHash == bytes32(0)) {
            revert EmptyHash();
        }
    }
}
