// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IReputationRegistry {
    function getAgentHistory(address agent)
        external
        view
        returns (
            uint256 completedTasks,
            uint256 failedTasks,
            uint256 totalVolume,
            uint256 localScore,
            uint256 lastActivityTimestamp
        );

    function recordTaskOutcome(
        address agent,
        uint256 taskId,
        bool success,
        uint256 volumeStreamed
    ) external;
}

// Custom continuous-payment vault, independent of Superfluid.
// Settles via an x402-compatible nanopayment flow at the integration layer.
contract StreamingVault {
    uint256 public constant UNDERWRITER_FEE_BPS = 200;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_UNDERWRITERS = 16;

    enum TaskStatus {
        NONE,
        OPEN,
        COLLATERAL_POSTED,
        STREAMING,
        PAUSED,
        COMPLETED,
        SLASHED,
        CANCELLED
    }

    struct Task {
        address creator;
        address agent;
        uint256 totalAmount;
        uint256 requiredCollateral;
        uint256 collateralLocked;
        uint256 ratePerSecond;
        uint256 accruedAmount;
        uint256 withdrawnAmount;
        uint64 collateralDeadline;
        uint64 lastAccrualTimestamp;
        TaskStatus status;
        uint256 agentCollateral;
        uint256 totalUnderwritten;
        uint256 agentPayoutPaid;
    }

    IERC20 public immutable usdc;
    IReputationRegistry public immutable reputationRegistry;
    uint64 public immutable collateralTimeout;

    address public owner;
    address public disputeModule;
    uint256 public nextTaskId = 1;
    mapping(uint256 => Task) public tasks;
    /// @notice Optional agent wallet reserved by the creator for an open order.
    /// @dev Zero address means any agent may claim. Kept outside Task so the
    ///      existing public task tuple remains backwards-compatible.
    mapping(uint256 => address) public preferredAgents;
    mapping(uint256 => mapping(address => uint256)) public underwrittenCollateral;
    mapping(uint256 => address[]) private taskUnderwriters;
    /// @notice Hash of the final deliverable/evidence packet submitted by the agent.
    mapping(uint256 => bytes32) public resultProofHashes;

    mapping(address => uint256) public nonces;

    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant TASK_INTENT_TYPEHASH = keccak256(
        "TaskIntent(address client,address agent,uint256 totalAmount,uint256 requiredCollateralPct,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant NAME_HASH = keccak256("PACT Streaming Vault");
    bytes32 private constant VERSION_HASH = keccak256("1");

    uint256 private locked = 1;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event DisputeModuleUpdated(address indexed previousModule, address indexed newModule);
    event TaskCreated(
        uint256 indexed taskId,
        address indexed creator,
        address indexed agent,
        uint256 totalAmount,
        uint256 requiredCollateral,
        uint256 collateralDeadline
    );
    event TaskAssigned(
        uint256 indexed taskId,
        address indexed agent,
        uint256 requiredCollateral,
        uint256 collateralDeadline
    );
    event CollateralPosted(uint256 indexed taskId, address indexed agent, uint256 amount);
    event CollateralUnderwritten(
        uint256 indexed taskId,
        address indexed underwriter,
        uint256 amount,
        uint256 totalUnderwritten
    );
    event UnderwriterSettled(
        uint256 indexed taskId,
        address indexed underwriter,
        uint256 principalReturned,
        uint256 feePaid,
        uint256 collateralLost
    );
    event StreamStarted(uint256 indexed taskId, uint256 ratePerSecond, uint256 timestamp);
    event StreamWithdrawn(uint256 indexed taskId, address indexed agent, uint256 amount);
    event ResultProofSubmitted(uint256 indexed taskId, address indexed agent, bytes32 proofHash);
    event StreamPaused(uint256 indexed taskId, uint256 accruedAmount, uint256 timestamp);
    event StreamResumed(uint256 indexed taskId, uint256 timestamp);
    event TaskCompleted(uint256 indexed taskId, uint256 paidToAgent, uint256 collateralReturned);
    event CollateralSlashed(
        uint256 indexed taskId,
        uint256 slashPct,
        uint256 collateralSlashed,
        uint256 earnedByAgent,
        uint256 refundedToCreator
    );
    event TaskCancelled(uint256 indexed taskId, uint256 refundedToCreator);

    error Unauthorized();
    error ZeroAddress();
    error InvalidAmount();
    error InvalidPercentage();
    error InvalidState(TaskStatus current);
    error CollateralWindowClosed();
    error CancellationNotAvailable();
    error NothingToWithdraw();
    error TokenTransferFailed();
    error TransferFailed();
    error Reentrancy();
    error TooManyUnderwriters();
    error AgentNotAssigned();
    error AgentAlreadyAssigned();
    error NotPreferredAgent();
    error EmptyProof();
    error ProofRequired();

    constructor(
        address usdcAddress,
        address registryAddress,
        address disputeModuleAddress,
        uint64 collateralTimeoutSeconds
    ) {
        if (
            usdcAddress == address(0) ||
            registryAddress == address(0) ||
            disputeModuleAddress == address(0)
        ) revert ZeroAddress();
        if (collateralTimeoutSeconds == 0) revert InvalidAmount();

        usdc = IERC20(usdcAddress);
        reputationRegistry = IReputationRegistry(registryAddress);
        disputeModule = disputeModuleAddress;
        collateralTimeout = collateralTimeoutSeconds;
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        emit DisputeModuleUpdated(address(0), disputeModuleAddress);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier nonReentrant() {
        if (locked != 1) revert Reentrancy();
        locked = 2;
        _;
        locked = 1;
    }

    modifier onlyCreator(uint256 taskId) {
        Task storage task = tasks[taskId];
        if (msg.sender != task.creator) revert Unauthorized();
        _;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setDisputeModule(address newModule) external onlyOwner {
        if (newModule == address(0)) revert ZeroAddress();
        emit DisputeModuleUpdated(disputeModule, newModule);
        disputeModule = newModule;
    }

    function _getDomainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                NAME_HASH,
                VERSION_HASH,
                block.chainid,
                address(this)
            )
        );
    }

    function _verifyTaskIntent(
        address client,
        address agent,
        uint256 totalAmount,
        uint256 requiredCollateralPct,
        uint256 deadline,
        bytes calldata signature
    ) internal {
        if (block.timestamp > deadline) revert("Intent expired");

        bytes32 structHash = keccak256(
            abi.encode(
                TASK_INTENT_TYPEHASH,
                client,
                agent,
                totalAmount,
                requiredCollateralPct,
                nonces[client]++,
                deadline
            )
        );

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _getDomainSeparator(), structHash));

        require(signature.length == 65, "Invalid signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }

        address recoveredSigner = ecrecover(digest, v, r, s);
        require(recoveredSigner != address(0) && recoveredSigner == client, "Invalid signature");
    }

    function createTaskWithIntent(
        address client,
        address agent,
        uint256 totalAmount,
        uint256 requiredCollateralPct,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant returns (uint256 taskId) {
        _verifyTaskIntent(client, agent, totalAmount, requiredCollateralPct, deadline, signature);

        if (agent == address(0)) revert ZeroAddress();
        if (totalAmount == 0) revert InvalidAmount();
        if (requiredCollateralPct > 100) revert InvalidPercentage();

        uint256 requiredCollateral = (totalAmount * requiredCollateralPct) / 100;

        taskId = nextTaskId++;
        Task storage task = tasks[taskId];
        task.creator = client;
        task.agent = agent;
        task.totalAmount = totalAmount;
        task.requiredCollateral = requiredCollateral;
        task.collateralDeadline = uint64(block.timestamp + collateralTimeout);
        task.status = TaskStatus.OPEN;

        if (!usdc.transferFrom(client, address(this), totalAmount)) revert TransferFailed();

        emit TaskCreated(
            taskId,
            client,
            agent,
            totalAmount,
            requiredCollateral,
            task.collateralDeadline
        );
    }

    function createTask(
        address agent,
        uint256 totalAmount,
        uint256 requiredCollateralPct
    ) external nonReentrant returns (uint256 taskId) {
        if (agent == address(0)) revert ZeroAddress();
        if (totalAmount == 0) revert InvalidAmount();
        if (requiredCollateralPct > 100) revert InvalidPercentage();

        taskId = nextTaskId++;
        uint256 collateral = _percentageCeil(totalAmount, requiredCollateralPct);
        uint64 deadline = uint64(block.timestamp + collateralTimeout);
        tasks[taskId] = Task({
            creator: msg.sender,
            agent: agent,
            totalAmount: totalAmount,
            requiredCollateral: collateral,
            collateralLocked: 0,
            ratePerSecond: 0,
            accruedAmount: 0,
            withdrawnAmount: 0,
            collateralDeadline: deadline,
            lastAccrualTimestamp: 0,
            status: TaskStatus.OPEN,
            agentCollateral: 0,
            totalUnderwritten: 0,
            agentPayoutPaid: 0
        });

        _safeTransferFrom(msg.sender, address(this), totalAmount);
        emit TaskCreated(taskId, msg.sender, agent, totalAmount, collateral, deadline);
    }

    /// @notice Funds a public work order before an agent has claimed it.
    /// @dev The creator can cancel while the order is unassigned. Once an agent is
    ///      assigned, the normal collateral timeout and settlement lifecycle apply.
    function createOpenTask(uint256 totalAmount, uint256 ratePerSecond, address preferredAgent)
        external
        nonReentrant
        returns (uint256 taskId)
    {
        if (totalAmount == 0 || ratePerSecond == 0) revert InvalidAmount();

        taskId = nextTaskId++;
        tasks[taskId] = Task({
            creator: msg.sender,
            agent: address(0),
            totalAmount: totalAmount,
            requiredCollateral: 0,
            collateralLocked: 0,
            ratePerSecond: ratePerSecond,
            accruedAmount: 0,
            withdrawnAmount: 0,
            collateralDeadline: 0,
            lastAccrualTimestamp: 0,
            status: TaskStatus.OPEN,
            agentCollateral: 0,
            totalUnderwritten: 0,
            agentPayoutPaid: 0
        });
        preferredAgents[taskId] = preferredAgent;

        _safeTransferFrom(msg.sender, address(this), totalAmount);
        emit TaskCreated(taskId, msg.sender, address(0), totalAmount, 0, 0);
    }

    /// @notice Claims a public work order with the caller's own wallet.
    /// @dev Collateral is derived from the public on-chain reputation record, so
    ///      neither the agent nor a platform server can lower it while claiming.
    function claimOpenTask(uint256 taskId) external {
        Task storage task = tasks[taskId];
        if (task.status != TaskStatus.OPEN) revert InvalidState(task.status);
        if (task.agent != address(0)) revert AgentAlreadyAssigned();
        address preferredAgent = preferredAgents[taskId];
        if (preferredAgent != address(0) && preferredAgent != msg.sender) revert NotPreferredAgent();

        uint256 requiredCollateralPct = requiredCollateralPctForAgent(msg.sender);
        uint64 deadline = uint64(block.timestamp + collateralTimeout);
        task.agent = msg.sender;
        task.requiredCollateral = _percentageCeil(task.totalAmount, requiredCollateralPct);
        task.collateralDeadline = deadline;
        emit TaskAssigned(taskId, msg.sender, task.requiredCollateral, deadline);
    }

    /// @notice Assigns a known agent to a private/direct work order.
    /// @dev Only the creator may make this decision; PACT has no global operator
    ///      that can impersonate either participant.
    function assignAgent(
        uint256 taskId,
        address agent,
        uint256 requiredCollateralPct
    )
        external
        onlyCreator(taskId)
    {
        Task storage task = tasks[taskId];
        if (task.status != TaskStatus.OPEN) revert InvalidState(task.status);
        if (task.agent != address(0)) revert AgentAlreadyAssigned();
        if (agent == address(0)) revert ZeroAddress();
        if (requiredCollateralPct > 100) revert InvalidPercentage();

        uint64 deadline = uint64(block.timestamp + collateralTimeout);
        task.agent = agent;
        task.requiredCollateral = _percentageCeil(task.totalAmount, requiredCollateralPct);
        task.collateralDeadline = deadline;
        emit TaskAssigned(taskId, agent, task.requiredCollateral, deadline);
    }

    /// @notice Cancels and refunds an open order that no agent has claimed.
    function cancelOpenTask(uint256 taskId) external nonReentrant {
        Task storage task = tasks[taskId];
        if (msg.sender != task.creator) revert Unauthorized();
        if (task.status != TaskStatus.OPEN) revert InvalidState(task.status);
        if (task.agent != address(0)) revert AgentAlreadyAssigned();

        uint256 refund = task.totalAmount;
        task.status = TaskStatus.CANCELLED;
        _safeTransfer(task.creator, refund);
        emit TaskCancelled(taskId, refund);
    }

    /// @notice Commits third-party collateral before the agent starts the task.
    /// @dev The commitment is locked once made. It is returned on timeout, earns a
    ///      proportional stream fee on success, and shares collateral loss on slash.
    function underwriteCollateral(uint256 taskId, uint256 amount) external nonReentrant {
        Task storage task = tasks[taskId];
        if (task.status != TaskStatus.OPEN) revert InvalidState(task.status);
        if (task.agent == address(0)) revert AgentNotAssigned();
        if (block.timestamp > task.collateralDeadline) revert CollateralWindowClosed();
        if (amount == 0 || task.totalUnderwritten + amount > task.requiredCollateral) {
            revert InvalidAmount();
        }
        if (msg.sender == task.agent || msg.sender == task.creator) revert Unauthorized();

        if (underwrittenCollateral[taskId][msg.sender] == 0) {
            if (taskUnderwriters[taskId].length >= MAX_UNDERWRITERS) {
                revert TooManyUnderwriters();
            }
            taskUnderwriters[taskId].push(msg.sender);
        }
        underwrittenCollateral[taskId][msg.sender] += amount;
        task.totalUnderwritten += amount;
        _safeTransferFrom(msg.sender, address(this), amount);
        emit CollateralUnderwritten(taskId, msg.sender, amount, task.totalUnderwritten);
    }

    function postCollateral(uint256 taskId) external nonReentrant {
        Task storage task = tasks[taskId];
        if (task.status != TaskStatus.OPEN) revert InvalidState(task.status);
        if (msg.sender != task.agent) revert Unauthorized();
        if (block.timestamp > task.collateralDeadline) revert CollateralWindowClosed();

        uint256 amount = task.requiredCollateral - task.totalUnderwritten;
        task.agentCollateral = amount;
        task.collateralLocked = task.requiredCollateral;
        task.status = TaskStatus.COLLATERAL_POSTED;
        if (amount != 0) _safeTransferFrom(msg.sender, address(this), amount);
        emit CollateralPosted(taskId, msg.sender, amount);

        // Public work orders contain creator-approved stream terms up front.
        // Once the claiming agent locks collateral, no privileged relay is
        // needed to start settlement.
        if (task.ratePerSecond != 0) {
            task.lastAccrualTimestamp = uint64(block.timestamp);
            task.status = TaskStatus.STREAMING;
            emit StreamStarted(taskId, task.ratePerSecond, block.timestamp);
        }
    }

    function startStream(uint256 taskId, uint256 ratePerSecond)
        external
        onlyCreator(taskId)
    {
        Task storage task = tasks[taskId];
        if (task.status != TaskStatus.COLLATERAL_POSTED) revert InvalidState(task.status);
        if (ratePerSecond == 0) revert InvalidAmount();

        task.ratePerSecond = ratePerSecond;
        task.lastAccrualTimestamp = uint64(block.timestamp);
        task.status = TaskStatus.STREAMING;
        emit StreamStarted(taskId, ratePerSecond, block.timestamp);
    }

    function withdrawStreamed(uint256 taskId) external nonReentrant {
        Task storage task = tasks[taskId];
        if (msg.sender != task.agent) revert Unauthorized();
        if (task.status != TaskStatus.STREAMING) {
            revert InvalidState(task.status);
        }

        uint256 accrued = _checkpoint(task);
        uint256 netAccrued = accrued - _underwriterFeeAt(task, accrued);
        uint256 amount = netAccrued - task.agentPayoutPaid;
        if (amount == 0) revert NothingToWithdraw();
        task.withdrawnAmount = accrued;
        task.agentPayoutPaid = netAccrued;

        _safeTransfer(task.agent, amount);
        emit StreamWithdrawn(taskId, task.agent, amount);
    }

    function pauseStream(uint256 taskId) external onlyCreator(taskId) {
        Task storage task = tasks[taskId];
        if (task.status != TaskStatus.STREAMING) revert InvalidState(task.status);
        uint256 accrued = _checkpoint(task);
        task.status = TaskStatus.PAUSED;
        emit StreamPaused(taskId, accrued, block.timestamp);
    }

    /// @notice Freezes accrual when either task participant opens a dispute.
    /// @dev The caller signs this action directly. Only the configured dispute
    ///      module may resume or settle after the evidence decision.
    function pauseForDispute(uint256 taskId) external {
        Task storage task = tasks[taskId];
        if (msg.sender != task.creator && msg.sender != task.agent) revert Unauthorized();
        if (task.status != TaskStatus.STREAMING) revert InvalidState(task.status);
        uint256 accrued = _checkpoint(task);
        task.status = TaskStatus.PAUSED;
        emit StreamPaused(taskId, accrued, block.timestamp);
    }

    function resumeStream(uint256 taskId) external onlyCreator(taskId) {
        Task storage task = tasks[taskId];
        if (task.status != TaskStatus.PAUSED) revert InvalidState(task.status);
        task.lastAccrualTimestamp = uint64(block.timestamp);
        task.status = TaskStatus.STREAMING;
        emit StreamResumed(taskId, block.timestamp);
    }

    function resumeAfterDispute(uint256 taskId) external {
        if (msg.sender != disputeModule) revert Unauthorized();
        Task storage task = tasks[taskId];
        if (task.status != TaskStatus.PAUSED) revert InvalidState(task.status);
        task.lastAccrualTimestamp = uint64(block.timestamp);
        task.status = TaskStatus.STREAMING;
        emit StreamResumed(taskId, block.timestamp);
    }

    /// @notice Anchors the final off-chain deliverable before settlement.
    /// @dev The contract stores only a hash; the evidence packet stays private
    ///      in PACT storage and can be verified against this receipt.
    function submitResultProof(uint256 taskId, bytes32 proofHash) external {
        Task storage task = tasks[taskId];
        if (msg.sender != task.agent) revert Unauthorized();
        if (task.status != TaskStatus.STREAMING && task.status != TaskStatus.PAUSED) {
            revert InvalidState(task.status);
        }
        if (proofHash == bytes32(0)) revert EmptyProof();
        resultProofHashes[taskId] = proofHash;
        emit ResultProofSubmitted(taskId, msg.sender, proofHash);
    }

    /// @notice Mirrors the published PACT collateral tiers using only canonical
    ///         reputation data available to every Arc participant.
    function requiredCollateralPctForAgent(address agent) public view returns (uint256) {
        (, , , uint256 score, ) = reputationRegistry.getAgentHistory(agent);
        if (score >= 701) return 0;
        if (score >= 401) return 10;
        if (score >= 101) return 25;
        return 50;
    }

    function completeTask(uint256 taskId) external nonReentrant {
        Task storage task = tasks[taskId];
        if (msg.sender != task.creator) revert Unauthorized();
        if (task.status != TaskStatus.STREAMING && task.status != TaskStatus.PAUSED) {
            revert InvalidState(task.status);
        }
        if (resultProofHashes[taskId] == bytes32(0)) revert ProofRequired();

        uint256 underwriterFee = _underwriterFeeAt(task, task.totalAmount);
        uint256 agentTotalPayout = task.totalAmount - underwriterFee;
        uint256 remainingPayment = agentTotalPayout - task.agentPayoutPaid;
        uint256 collateral = task.collateralLocked;
        task.withdrawnAmount = task.totalAmount;
        task.agentPayoutPaid = agentTotalPayout;
        task.accruedAmount = task.totalAmount;
        task.collateralLocked = 0;
        task.status = TaskStatus.COMPLETED;

        if (remainingPayment != 0) _safeTransfer(task.agent, remainingPayment);
        if (task.agentCollateral != 0) _safeTransfer(task.agent, task.agentCollateral);
        _settleUnderwritersOnSuccess(taskId, task, underwriterFee);
        reputationRegistry.recordTaskOutcome(task.agent, taskId, true, task.totalAmount);
        emit TaskCompleted(taskId, remainingPayment, collateral);
    }

    function slashCollateral(uint256 taskId, uint256 slashPct) external nonReentrant {
        if (msg.sender != disputeModule) revert Unauthorized();
        if (slashPct > 100) revert InvalidPercentage();
        Task storage task = tasks[taskId];
        if (task.status != TaskStatus.STREAMING && task.status != TaskStatus.PAUSED) {
            revert InvalidState(task.status);
        }

        uint256 accrued = _checkpoint(task);
        // Earned stream value is payment for work already performed. Only the
        // collateral is slashable; the accrued payout remains with the agent.
        uint256 earned = accrued - task.agentPayoutPaid;
        uint256 refund = task.totalAmount - accrued;
        uint256 collateral = task.collateralLocked;
        uint256 collateralReturned = task.agentCollateral -
            ((task.agentCollateral * slashPct) / 100);
        collateralReturned += _settleUnderwritersOnSlash(taskId, slashPct);
        uint256 slashed = collateral - collateralReturned;

        task.withdrawnAmount = accrued;
        task.agentPayoutPaid = accrued;
        task.collateralLocked = 0;
        task.status = TaskStatus.SLASHED;

        if (earned != 0) _safeTransfer(task.agent, earned);
        uint256 agentCollateralReturned = task.agentCollateral -
            ((task.agentCollateral * slashPct) / 100);
        if (agentCollateralReturned != 0) {
            _safeTransfer(task.agent, agentCollateralReturned);
        }
        if (refund + slashed != 0) _safeTransfer(task.creator, refund + slashed);
        reputationRegistry.recordTaskOutcome(task.agent, taskId, false, accrued);
        emit CollateralSlashed(taskId, slashPct, slashed, earned, refund);
    }

    function cancelTaskAfterTimeout(uint256 taskId) external nonReentrant {
        Task storage task = tasks[taskId];
        if (msg.sender != task.creator) revert Unauthorized();
        if (task.status != TaskStatus.OPEN) revert InvalidState(task.status);
        if (task.agent == address(0)) revert AgentNotAssigned();
        if (block.timestamp <= task.collateralDeadline) revert CancellationNotAvailable();

        uint256 refund = task.totalAmount;
        task.status = TaskStatus.CANCELLED;
        _safeTransfer(task.creator, refund);
        address[] storage underwriters = taskUnderwriters[taskId];
        for (uint256 i = 0; i < underwriters.length; ++i) {
            address underwriter = underwriters[i];
            uint256 contribution = underwrittenCollateral[taskId][underwriter];
            if (contribution != 0) {
                _safeTransfer(underwriter, contribution);
                emit UnderwriterSettled(taskId, underwriter, contribution, 0, 0);
            }
        }
        emit TaskCancelled(taskId, refund);
    }

    function accruedAmount(uint256 taskId) external view returns (uint256) {
        return _currentAccrued(tasks[taskId]);
    }

    function withdrawableAmount(uint256 taskId) external view returns (uint256) {
        Task storage task = tasks[taskId];
        uint256 accrued = _currentAccrued(task);
        uint256 netAccrued = accrued - _underwriterFeeAt(task, accrued);
        return netAccrued > task.agentPayoutPaid ? netAccrued - task.agentPayoutPaid : 0;
    }

    function getTaskUnderwriters(uint256 taskId) external view returns (address[] memory) {
        return taskUnderwriters[taskId];
    }

    function _checkpoint(Task storage task) internal returns (uint256 accrued) {
        accrued = _currentAccrued(task);
        task.accruedAmount = accrued;
        if (task.status == TaskStatus.STREAMING) {
            task.lastAccrualTimestamp = uint64(block.timestamp);
        }
    }

    function _currentAccrued(Task storage task) internal view returns (uint256) {
        uint256 accrued = task.accruedAmount;
        if (task.status == TaskStatus.STREAMING) {
            accrued += task.ratePerSecond * (block.timestamp - task.lastAccrualTimestamp);
        }
        return accrued > task.totalAmount ? task.totalAmount : accrued;
    }

    function _percentageCeil(uint256 amount, uint256 pct) internal pure returns (uint256) {
        if (pct == 0) return 0;
        return ((amount * pct) + 99) / 100;
    }

    function _underwriterFeeAt(Task storage task, uint256 grossAmount)
        internal
        view
        returns (uint256)
    {
        if (task.totalUnderwritten == 0 || task.requiredCollateral == 0) return 0;
        return
            (grossAmount * UNDERWRITER_FEE_BPS * task.totalUnderwritten) /
            (BPS_DENOMINATOR * task.requiredCollateral);
    }

    function _settleUnderwritersOnSuccess(
        uint256 taskId,
        Task storage task,
        uint256 totalFee
    ) internal {
        address[] storage underwriters = taskUnderwriters[taskId];
        uint256 distributedFee;
        for (uint256 i = 0; i < underwriters.length; ++i) {
            address underwriter = underwriters[i];
            uint256 principal = underwrittenCollateral[taskId][underwriter];
            uint256 fee = i + 1 == underwriters.length
                ? totalFee - distributedFee
                : (totalFee * principal) / task.totalUnderwritten;
            distributedFee += fee;
            _safeTransfer(underwriter, principal + fee);
            emit UnderwriterSettled(taskId, underwriter, principal, fee, 0);
        }
    }

    function _settleUnderwritersOnSlash(uint256 taskId, uint256 slashPct)
        internal
        returns (uint256 returned)
    {
        address[] storage underwriters = taskUnderwriters[taskId];
        for (uint256 i = 0; i < underwriters.length; ++i) {
            address underwriter = underwriters[i];
            uint256 principal = underwrittenCollateral[taskId][underwriter];
            uint256 loss = (principal * slashPct) / 100;
            uint256 principalReturned = principal - loss;
            returned += principalReturned;
            if (principalReturned != 0) _safeTransfer(underwriter, principalReturned);
            emit UnderwriterSettled(taskId, underwriter, principalReturned, 0, loss);
        }
    }

    function _safeTransfer(address to, uint256 amount) internal {
        (bool success, bytes memory result) = address(usdc).call(
            abi.encodeCall(IERC20.transfer, (to, amount))
        );
        if (!success || (result.length != 0 && !abi.decode(result, (bool)))) {
            revert TokenTransferFailed();
        }
    }

    function _safeTransferFrom(address from, address to, uint256 amount) internal {
        (bool success, bytes memory result) = address(usdc).call(
            abi.encodeCall(IERC20.transferFrom, (from, to, amount))
        );
        if (!success || (result.length != 0 && !abi.decode(result, (bool)))) {
            revert TokenTransferFailed();
        }
    }
}
