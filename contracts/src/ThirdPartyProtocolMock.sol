// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IOpenReputationRegistry {
    struct TaskOutcome {
        address writer;
        uint256 taskId;
        bool success;
        uint256 volume;
        uint256 timestamp;
    }

    function recordTaskOutcome(
        address agent,
        uint256 taskId,
        bool success,
        uint256 volumeStreamed
    ) external;

    function getAgentHistoryPage(address agent, uint256 offset, uint256 limit)
        external
        view
        returns (TaskOutcome[] memory page, uint256 total);
}

/// @notice Demonstrates that an unrelated Arc protocol can compose with PACT
///         without requiring any code change in the registry.
contract ThirdPartyProtocolMock {
    IOpenReputationRegistry public immutable registry;

    constructor(address registryAddress) {
        registry = IOpenReputationRegistry(registryAddress);
    }

    function publishOutcome(
        address agent,
        uint256 externalTaskId,
        bool success,
        uint256 volume
    ) external {
        registry.recordTaskOutcome(agent, externalTaskId, success, volume);
    }

    function readHistory(address agent, uint256 offset, uint256 limit)
        external
        view
        returns (IOpenReputationRegistry.TaskOutcome[] memory page, uint256 total)
    {
        return registry.getAgentHistoryPage(agent, offset, limit);
    }
}
