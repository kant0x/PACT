// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IReputationRegistry {
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
    mapping(address => bool) public authorizedOperators;
    mapping(uint256 => Task) public tasks;
    mapping(uint256 => mapping(address => uint256)) public underwrittenCollateral;
    mapping(uint256 => address[]) private taskUnderwriters;

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
    event AuthorizedOperatorUpdated(address indexed operator, bool authorized);
    event DisputeModuleUpdated(address indexed previousModule, address indexed newModule);
    event TaskCreated(
        uint256 indexed taskId,
        address indexed creator,
        address indexed agent,
        uint256 totalAmount,
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
    event StreamPaused(uint256 indexed taskId, uint256 accruedAmount, uint256 timestamp);
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

    modifier onlyCreatorOrOperator(uint256 taskId) {
        Task storage task = tasks[taskId];
        if (msg.sender != task.creator && !authorizedOperators[msg.sender]) revert Unauthorized();
        _;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setAuthorizedOperator(address operator, bool authorized) external onlyOwner {
        if (operator == address(0)) revert ZeroAddress();
        authorizedOperators[operator] = authorized;
        emit AuthorizedOperatorUpdated(operator, authorized);
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

    /// @notice Commits third-party collateral before the agent starts the task.
    /// @dev The commitment is locked once made. It is returned on timeout, earns a
    ///      proportional stream fee on success, and shares collateral loss on slash.
    function underwriteCollateral(uint256 taskId, uint256 amount) external nonReentrant {
        Task storage task = tasks[taskId];
        if (task.status != TaskStatus.OPEN) revert InvalidState(task.status);
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
    }

    function startStream(uint256 taskId, uint256 ratePerSecond)
        external
        onlyCreatorOrOperator(taskId)
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

    function pauseStream(uint256 taskId) external onlyCreatorOrOperator(taskId) {
        Task storage task = tasks[taskId];
        if (task.status != TaskStatus.STREAMING) revert InvalidState(task.status);
        uint256 accrued = _checkpoint(task);
        task.status = TaskStatus.PAUSED;
        emit StreamPaused(taskId, accrued, block.timestamp);
    }

    function completeTask(uint256 taskId) external nonReentrant {
        Task storage task = tasks[taskId];
        if (msg.sender != task.creator) revert Unauthorized();
        if (task.status != TaskStatus.STREAMING && task.status != TaskStatus.PAUSED) {
            revert InvalidState(task.status);
        }

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
