// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract ReputationRegistry {
    uint256 public constant MAX_PAGE_SIZE = 100;
    uint256 public constant MAX_IMPORTED_SCORE = 400;

    struct AgentHistory {
        uint256 completedTasks;
        uint256 failedTasks;
        uint256 totalVolume;
        uint256 localScore;
        uint256 lastActivityTimestamp;
    }

    struct TaskOutcome {
        address writer;
        uint256 taskId;
        bool success;
        uint256 volume;
        uint256 timestamp;
    }

    struct PortableReputation {
        uint256 recognizedScore;
        uint256 claimedScore;
        uint256 completedTasks;
        uint256 failedTasks;
        uint256 totalVolume;
        uint32 sourceDomain;
        uint256 nonce;
        address attestor;
        uint256 importedAt;
    }

    struct ExternalAttestationProof {
        uint32 sourceDomain;
        uint256 externalScore;
        uint256 completedTasks;
        uint256 failedTasks;
        uint256 totalVolume;
        uint256 nonce;
        uint256 deadline;
        bytes signature;
    }

    address public owner;
    mapping(address => bool) public authorizedWriters;
    mapping(address => bool) public authorizedAttestors;
    mapping(bytes32 => bool) public taskOutcomeRecorded;
    mapping(address => AgentHistory) private histories;
    mapping(address => TaskOutcome[]) private outcomes;
    mapping(address => PortableReputation) private portableReputations;
    mapping(address => mapping(address => mapping(uint32 => uint256))) public lastImportedNonce;

    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant ATTESTATION_TYPEHASH = keccak256(
        "ExternalReputation(address agent,uint32 sourceDomain,uint256 externalScore,uint256 completedTasks,uint256 failedTasks,uint256 totalVolume,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant NAME_HASH = keccak256("PACT Reputation Registry");
    bytes32 private constant VERSION_HASH = keccak256("1");
    uint256 private constant SECP256K1N_HALF =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AuthorizedWriterUpdated(address indexed writer, bool authorized);
    event AuthorizedAttestorUpdated(address indexed attestor, bool authorized);
    event TaskOutcomeRecorded(
        address indexed agent,
        address indexed writer,
        uint256 indexed taskId,
        bool success,
        uint256 volume,
        uint256 timestamp
    );
    event ExternalAttestationImported(
        address indexed agent,
        address indexed attestor,
        uint32 indexed sourceDomain,
        uint256 claimedScore,
        uint256 recognizedScore,
        uint256 nonce
    );

    error Unauthorized();
    error ZeroAddress();
    error TaskOutcomeAlreadyRecorded(address writer, uint256 taskId);
    error InvalidPage();
    error InvalidScore();
    error InvalidSignature();
    error AttestationExpired();
    error StaleAttestation();

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
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

    function addAuthorizedWriter(address writer) external onlyOwner {
        if (writer == address(0)) revert ZeroAddress();
        authorizedWriters[writer] = true;
        emit AuthorizedWriterUpdated(writer, true);
    }

    function removeAuthorizedWriter(address writer) external onlyOwner {
        if (writer == address(0)) revert ZeroAddress();
        authorizedWriters[writer] = false;
        emit AuthorizedWriterUpdated(writer, false);
    }

    function setAuthorizedAttestor(address attestor, bool authorized) external onlyOwner {
        if (attestor == address(0)) revert ZeroAddress();
        authorizedAttestors[attestor] = authorized;
        emit AuthorizedAttestorUpdated(attestor, authorized);
    }

    function recordTaskOutcome(
        address agent,
        uint256 taskId,
        bool success,
        uint256 volumeStreamed
    ) external onlyAuthorizedWriter {
        if (agent == address(0)) revert ZeroAddress();
        bytes32 outcomeId = keccak256(abi.encode(msg.sender, taskId));
        if (taskOutcomeRecorded[outcomeId]) {
            revert TaskOutcomeAlreadyRecorded(msg.sender, taskId);
        }

        taskOutcomeRecorded[outcomeId] = true;
        AgentHistory storage history = histories[agent];
        if (history.localScore == 0 && history.completedTasks == 0 && history.failedTasks == 0) {
            history.localScore = 100; // default start score
        }

        if (success) {
            history.completedTasks += 1;
            if (history.localScore < 1000) {
                history.localScore += 5; // Reward
            }
        } else {
            history.failedTasks += 1;
            if (history.localScore >= 25) {
                history.localScore -= 25; // Slash penalty
            } else {
                history.localScore = 0;
            }
        }
        history.totalVolume += volumeStreamed;
        history.lastActivityTimestamp = block.timestamp;
        outcomes[agent].push(
            TaskOutcome({
                writer: msg.sender,
                taskId: taskId,
                success: success,
                volume: volumeStreamed,
                timestamp: block.timestamp
            })
        );

        emit TaskOutcomeRecorded(
            agent,
            msg.sender,
            taskId,
            success,
            volumeStreamed,
            block.timestamp
        );
    }

    function getAgentHistory(address agent)
        external
        view
        returns (
            uint256 completedTasks,
            uint256 failedTasks,
            uint256 totalVolume,
            uint256 localScore,
            uint256 lastActivityTimestamp
        )
    {
        AgentHistory storage history = histories[agent];
        return (
            history.completedTasks,
            history.failedTasks,
            history.totalVolume,
            history.localScore == 0 && history.completedTasks == 0 && history.failedTasks == 0 ? 100 : history.localScore,
            history.lastActivityTimestamp
        );
    }

    function isTaskOutcomeRecorded(address writer, uint256 taskId) external view returns (bool) {
        return taskOutcomeRecorded[keccak256(abi.encode(writer, taskId))];
    }

    function getAgentHistoryPage(address agent, uint256 offset, uint256 limit)
        external
        view
        returns (TaskOutcome[] memory page, uint256 total)
    {
        if (limit == 0 || limit > MAX_PAGE_SIZE) revert InvalidPage();
        TaskOutcome[] storage agentOutcomes = outcomes[agent];
        total = agentOutcomes.length;
        if (offset >= total) return (new TaskOutcome[](0), total);

        uint256 end = offset + limit;
        if (end > total) end = total;
        page = new TaskOutcome[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = agentOutcomes[i];
        }
    }

    function externalAttestationDigest(
        address agent,
        uint32 sourceDomain,
        uint256 externalScore,
        uint256 completedTasks,
        uint256 failedTasks,
        uint256 totalVolume,
        uint256 nonce,
        uint256 deadline
    ) public view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                NAME_HASH,
                VERSION_HASH,
                block.chainid,
                address(this)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                ATTESTATION_TYPEHASH,
                agent,
                sourceDomain,
                externalScore,
                completedTasks,
                failedTasks,
                totalVolume,
                nonce,
                deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    /// @notice Imports a trusted, EIP-712 signed reputation snapshot.
    /// @dev signedProof is abi.encode(sourceDomain, score, completed, failed, volume,
    ///      nonce, deadline, signature). The imported score is deliberately capped so
    ///      portable history helps cold-start without granting top-tier local trust.
    function importExternalAttestation(address agent, bytes calldata signedProof) external {
        if (agent == address(0)) revert ZeroAddress();
        ExternalAttestationProof memory proof = abi.decode(
            signedProof,
            (ExternalAttestationProof)
        );

        if (proof.externalScore > 1000) revert InvalidScore();
        if (block.timestamp > proof.deadline) revert AttestationExpired();
        bytes32 digest = externalAttestationDigest(
            agent,
            proof.sourceDomain,
            proof.externalScore,
            proof.completedTasks,
            proof.failedTasks,
            proof.totalVolume,
            proof.nonce,
            proof.deadline
        );
        address attestor = _recover(digest, proof.signature);
        if (!authorizedAttestors[attestor]) revert Unauthorized();
        if (proof.nonce <= lastImportedNonce[attestor][agent][proof.sourceDomain]) {
            revert StaleAttestation();
        }
        lastImportedNonce[attestor][agent][proof.sourceDomain] = proof.nonce;

        uint256 recognizedScore = proof.externalScore > MAX_IMPORTED_SCORE
            ? MAX_IMPORTED_SCORE
            : proof.externalScore;
        portableReputations[agent] = PortableReputation({
            recognizedScore: recognizedScore,
            claimedScore: proof.externalScore,
            completedTasks: proof.completedTasks,
            failedTasks: proof.failedTasks,
            totalVolume: proof.totalVolume,
            sourceDomain: proof.sourceDomain,
            nonce: proof.nonce,
            attestor: attestor,
            importedAt: block.timestamp
        });

        emit ExternalAttestationImported(
            agent,
            attestor,
            proof.sourceDomain,
            proof.externalScore,
            recognizedScore,
            proof.nonce
        );
    }

    function getPortableReputation(address agent)
        external
        view
        returns (PortableReputation memory)
    {
        return portableReputations[agent];
    }

    function _recover(bytes32 digest, bytes memory signature) private pure returns (address) {
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        if (uint256(s) > SECP256K1N_HALF || (v != 27 && v != 28)) {
            revert InvalidSignature();
        }
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
        return signer;
    }
}
