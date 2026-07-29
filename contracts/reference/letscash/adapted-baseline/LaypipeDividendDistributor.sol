// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {IUniswapV3Factory} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import {IUniswapV3SwapCallback} from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {CurrencySettler} from "./lib/CurrencySettler.sol";
import {PipedogHook} from "./PipedogHook.sol";
import {IWETH9} from "./PipedogBuybackBurner.sol";

interface ILaypipeCheckpointToken is IERC20 {
    function supportsBalanceCheckpoints() external pure returns (bool);
    function checkpointClock() external view returns (uint64);
    function balanceOfAt(address account, uint64 checkpointId) external view returns (uint256);
}

interface IDividendSwapAdapter {
    function validate(address dividendToken, bytes calldata routeData) external view returns (bool);
    function swap(address dividendToken, bytes calldata routeData) external payable returns (uint256 amountOut);
}

/// @title LaypipeDividendDistributor
/// @notice Fee recipient for dividend launches: the creator share of every fee
///         is converted into the token's chosen dividend asset and pushed to
///         eligible holders, pro rata. One contract serves every dividend pool.
///
///         Nobody operates this. Every step of a distribution round is
///         permissionless and pays its caller from the pool's own fees, the
///         same keeper-bounty economics that drive the platform's burns. The
///         contract has no owner, no withdrawal path, and no way to redirect
///         a pool's stream — not for the creator, not for the platform.
///
///         Rounds are two-pass because pro-rata needs its denominator first:
///           1. startRound   claims fees, converts one bounded chunk to the
///                           dividend asset, opens enrollment
///           2. enroll       anyone submits holder addresses in batches; the
///                           contract reads each balance from the token itself
///                           (amounts cannot be forged, duplicates are
///                           rejected, and anyone omitted can selfEnroll)
///           3. finalize     closes enrollment after the window
///           4. payout       pays recorded holders their share, in batches
///
/// @dev The dividend buy carries no slippage guard on purpose (for self-paying
///      tokens, moving the price is the point; for foreign assets the chunk
///      cap does the bounding). Exposure is bounded two ways: each round
///      converts at most MAX_SWAP_PER_CALL of fees, and a pool starts at most
///      one round per block — backlogs drain across rounds rather than
///      becoming one sandwich-sized clip. The dividend asset itself is chosen
///      by the creator at launch and is displayed on every surface; a
///      malicious choice can only ever damage that token's own fee stream.
contract LaypipeDividendDistributor is IUnlockCallback, IUniswapV3SwapCallback, ReentrancyGuard {
    using CurrencySettler for Currency;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    error NotFactory();
    error NotPoolManager();
    error NotV3Pool();
    error V3OwedTooHigh();
    error SwapInputTooHigh();
    error AdapterSwapFailed();
    error UnknownPool();
    error AlreadyRegistered();
    error InvalidDividendConfig();
    error RoundActive();
    error NoActiveRound();
    error WrongPhase();
    error EnrollmentClosed();
    error EnrollmentOpen();
    error NothingToDistribute();
    error StartedThisBlock();
    error PayFailed();
    error ValueTooLarge();

    /// @notice How the ETH fee stream becomes the dividend asset.
    enum Route {
        ETH, // no conversion: holders receive native ETH
        V4, // buy on a direct native-ETH/WETH Uniswap v4 pool
        V3, // buy on a Uniswap v3 WETH pool (e.g. PIPEDOG)
        ADAPTER // isolated external adapter for V2, multi-hop, curves, and future venues
    }

    struct DividendParams {
        address dividendToken; // what holders receive; address(0) for Route.ETH
        uint96 minBalance; // eligibility floor, in launched-token wei
        Route route;
        PoolKey v4Key; // Route.V4: the pool the dividend asset trades on
        address v3Pool; // Route.V3: the WETH pool the asset trades on
        address adapter; // Route.ADAPTER: isolated route executor
        bytes adapterData; // immutable adapter-specific route description
    }

    struct PoolConfig {
        address token; // the launched pipedog token (eligibility source)
        address dividendToken;
        uint96 minBalance;
        Route route;
        bool v3TokenIs0; // Route.V3: dividend token is token0 of the pool
        bool v4InputIs0; // Route.V4: native ETH/WETH is currency0
        bool v4InputIsWeth; // Route.V4: wrap ETH before settlement
        PoolKey v4Key;
        IUniswapV3Pool v3Pool;
        IDividendSwapAdapter adapter;
        bytes adapterData;
    }

    struct Round {
        uint64 id; // 0 = pool has never run a round
        uint8 phase; // 0 idle, 1 enrolling, 2 paying
        uint40 enrollEnd;
        uint32 count; // entries recorded
        uint32 paidCursor; // entries paid so far
        uint128 potAsset; // amount being distributed this round
        uint128 totalEligible; // sum of enrolled balances
        uint128 distributed; // actually transferred so far
    }

    event Registered(
        PoolId indexed poolId, address indexed token, address indexed dividendToken, uint8 route, uint96 minBalance
    );
    event RoundStarted(
        PoolId indexed poolId, uint64 indexed roundId, uint256 potAsset, uint256 ethConverted, uint40 enrollEnd
    );
    event Enrolled(PoolId indexed poolId, uint64 indexed roundId, uint256 added, uint256 totalEligible);
    event RoundFinalized(PoolId indexed poolId, uint64 indexed roundId, uint256 holders, uint256 totalEligible);
    event RoundClosed(PoolId indexed poolId, uint64 indexed roundId, uint256 distributed, uint256 carried);

    /// @notice A round opens only once this much ETH has accrued — keeps
    ///         bounties worth the gas and rounds worth the noise.
    uint256 public constant MIN_ROUND_POT = 0.005 ether;
    /// @notice Most ETH a single round converts. Bounds what a sandwich around
    ///         one dividend buy can be worth; larger pots drain over rounds.
    uint256 public constant MAX_SWAP_PER_CALL = 0.5 ether;
    /// @notice Share of each round's chunk paid to whoever starts it, in bps.
    uint256 public constant BOUNTY_BPS = 100; // 1%
    /// @notice Additional share reserved for the transactions that must happen
    ///         after `startRound`. Without a dedicated reserve, a normal pot
    ///         below MAX_SWAP_PER_CALL would leave no ETH for enrollment,
    ///         finalization, or payout keepers after the starter consumed the
    ///         whole chunk.
    uint256 public constant KEEPER_RESERVE_BPS = 100; // 1%
    uint256 public constant ENROLL_RESERVE_SHARE_BPS = 2_500; // 25% of reserve
    uint256 public constant FINALIZE_RESERVE_SHARE_BPS = 2_500; // 25% of reserve
    /// @notice Flat ETH tip per holder processed, paid to enroll/payout
    ///         callers from the pool's own fee pot — several times the gas an
    ///         entry costs on this chain, so batch cranking is profitable.
    uint256 public constant TIP_PER_ENTRY = 1e13; // 0.00001 ETH
    /// @notice Enrollment window per round. Batches take seconds; the window
    ///         exists so stragglers can self-enroll before payment locks.
    uint256 public constant ENROLL_WINDOW = 10 minutes;
    /// @notice The eligibility floor must bound a round to at most this many
    ///         full-weight holders. This keeps permissionless cranks and their
    ///         per-entry tips economically bounded.
    uint256 public constant MAX_ELIGIBLE_HOLDERS = 10_000;
    /// @dev Gas forwarded to a dividend transfer — a poison recipient (or
    ///      poison asset) can waste this much, never the whole batch.
    uint256 private constant PAY_GAS_CAP = 100_000;
    uint256 public constant MAX_ADAPTER_DATA = 4096;

    uint160 private constant MIN_SQRT_RATIO_PLUS_1 = 4295128740;
    uint160 private constant MAX_SQRT_RATIO_MINUS_1 = 1461446703485210103287273052203988822378723970341;

    IPoolManager public immutable poolManager;
    PipedogHook public immutable hook;
    address public immutable factory;
    IWETH9 public immutable weth;
    IUniswapV3Factory public immutable v3Factory;

    mapping(PoolId => PoolConfig) private _cfg;
    /// @notice Claimed ETH waiting to be converted, per pool.
    mapping(PoolId => uint256) public ethPot;
    /// @notice Dividend asset waiting for the next round (round carry / dust).
    mapping(PoolId => uint256) public assetPot;
    /// @notice Set when a full pot carried from a zero-eligible round and is
    ///         waiting to be redistributed. Distinguishes a meaningful carry
    ///         (redistribute it) from a normal round's integer-division dust
    ///         (fold into the next real round, never trigger one alone).
    mapping(PoolId => bool) public pendingCarry;
    mapping(PoolId => Round) public rounds;
    mapping(PoolId => mapping(uint64 => address[])) private _entries;
    /// @notice Enrolled snapshot balance for a (pool, round, holder); nonzero
    ///         doubles as the "already enrolled" flag.
    mapping(PoolId => mapping(uint64 => mapping(address => uint128))) public enrolledBalance;
    /// @notice Immutable token-local balance checkpoint used by each round.
    mapping(PoolId => mapping(uint64 => uint64)) public roundCheckpoint;
    /// @notice Dedicated ETH funding for each post-start phase. These buckets
    ///         are round-local and cannot be consumed by a later round.
    mapping(PoolId => mapping(uint64 => uint256)) public enrollTipReserve;
    mapping(PoolId => mapping(uint64 => uint256)) public finalizeTipReserve;
    mapping(PoolId => mapping(uint64 => uint256)) public payoutTipReserve;
    /// @dev block.number tracks the parent chain on an Orbit rollup — coarser
    ///      (stricter) than one L2 block, which only slows drain cadence.
    mapping(PoolId => uint256) private _lastStartBlock;

    /// @dev The v3 swap currently in flight — the ONLY thing the v3 callback
    ///      authenticates against. Set around our own `pool.swap` call and
    ///      cleared after; transient so it never persists past the tx. The
    ///      callback authorising against a caller-supplied address instead of
    ///      this would let anyone claim to be the pool and drain the contract.
    address private transient _activeV3Pool;
    /// @dev WETH allowance remaining for the in-flight v3 swap. Every callback
    ///      consumes it, so even a hostile "pool" making repeated requests can
    ///      waste at most its own round's chunk — never another pool's ETH.
    uint256 private transient _activeV3Remaining;

    constructor(
        IPoolManager poolManager_,
        PipedogHook hook_,
        address factory_,
        IWETH9 weth_,
        IUniswapV3Factory v3Factory_
    ) {
        poolManager = poolManager_;
        hook = hook_;
        factory = factory_;
        weth = weth_;
        v3Factory = v3Factory_;
    }

    // ————————————————————— registration (factory) —————————————————————

    /// @notice The factory wires each dividend pool in at launch, after
    ///         validating nothing — validation lives here so the rules are
    ///         verifiable in one place.
    function register(PoolId poolId, address token, DividendParams calldata p) external {
        if (msg.sender != factory) revert NotFactory();
        if (_cfg[poolId].token != address(0)) revert AlreadyRegistered();
        if (token == address(0)) revert InvalidDividendConfig();

        // Dividend eligibility must come from immutable historical balances.
        // Reject an old/non-Pipedog token implementation before the pool can be
        // registered into a round lifecycle that would later be unserviceable.
        try ILaypipeCheckpointToken(token).supportsBalanceCheckpoints() returns (bool supported) {
            if (!supported) revert InvalidDividendConfig();
        } catch {
            revert InvalidDividendConfig();
        }
        uint256 supply = IERC20(token).totalSupply();
        if (supply == 0 || supply > type(uint128).max) revert InvalidDividendConfig();
        uint256 minimumFloor = ((supply - 1) / MAX_ELIGIBLE_HOLDERS) + 1;
        if (p.minBalance < minimumFloor) revert InvalidDividendConfig();

        bool v3TokenIs0 = false;
        bool v4InputIs0 = false;
        bool v4InputIsWeth = false;
        if (p.route == Route.ETH) {
            if (
                p.dividendToken != address(0) || p.adapter != address(0) || p.adapterData.length != 0
                    || p.v3Pool != address(0)
            ) revert InvalidDividendConfig();
        } else if (p.route == Route.V4) {
            if (
                p.dividendToken == address(0) || p.adapter != address(0) || p.adapterData.length != 0
                    || p.v3Pool != address(0)
            ) revert InvalidDividendConfig();
            address c0 = Currency.unwrap(p.v4Key.currency0);
            address c1 = Currency.unwrap(p.v4Key.currency1);
            if ((c0 == address(0) || c0 == address(weth)) && c1 == p.dividendToken) {
                v4InputIs0 = true;
                v4InputIsWeth = c0 == address(weth);
            } else if ((c1 == address(0) || c1 == address(weth)) && c0 == p.dividendToken) {
                v4InputIs0 = false;
                v4InputIsWeth = c1 == address(weth);
            } else {
                revert InvalidDividendConfig();
            }
            (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(p.v4Key.toId());
            if (sqrtPriceX96 == 0) revert InvalidDividendConfig();
        } else if (p.route == Route.V3) {
            // Route.V3: accept any live direct WETH pair from the canonical
            // factory. This keeps arbitrary ERC-20 payouts open without
            // trusting a launcher-supplied contract that merely impersonates
            // token0()/token1().
            if (
                p.dividendToken == address(0) || p.v3Pool == address(0) || p.adapter != address(0)
                    || p.adapterData.length != 0
            ) revert InvalidDividendConfig();
            IUniswapV3Pool v3Pool = IUniswapV3Pool(p.v3Pool);
            address t0 = v3Pool.token0();
            address t1 = v3Pool.token1();
            if (t0 == p.dividendToken && t1 == address(weth)) v3TokenIs0 = true;
            else if (t0 == address(weth) && t1 == p.dividendToken) v3TokenIs0 = false;
            else revert InvalidDividendConfig();
            if (
                v3Pool.factory() != address(v3Factory) || v3Factory.getPool(t0, t1, v3Pool.fee()) != p.v3Pool
                    || v3Pool.liquidity() == 0
            ) revert InvalidDividendConfig();
        } else {
            if (
                p.dividendToken == address(0) || p.adapter.code.length == 0 || p.v3Pool != address(0)
                    || p.adapterData.length > MAX_ADAPTER_DATA
            ) revert InvalidDividendConfig();
            try IDividendSwapAdapter(p.adapter).validate(p.dividendToken, p.adapterData) returns (bool valid) {
                if (!valid) revert InvalidDividendConfig();
            } catch {
                revert InvalidDividendConfig();
            }
        }

        _cfg[poolId] = PoolConfig({
            token: token,
            dividendToken: p.dividendToken,
            minBalance: p.minBalance,
            route: p.route,
            v3TokenIs0: v3TokenIs0,
            v4InputIs0: v4InputIs0,
            v4InputIsWeth: v4InputIsWeth,
            v4Key: p.v4Key,
            v3Pool: IUniswapV3Pool(p.v3Pool),
            adapter: IDividendSwapAdapter(p.adapter),
            adapterData: p.adapterData
        });
        emit Registered(poolId, token, p.dividendToken, uint8(p.route), p.minBalance);
    }

    // ————————————————————— the round lifecycle —————————————————————

    /// @notice Claims the pool's accrued fees, converts one bounded chunk into
    ///         the dividend asset, and opens enrollment. Callable by anyone;
    ///         pays the caller 1% of the chunk.
    function startRound(PoolId poolId) external nonReentrant returns (uint64 roundId) {
        PoolConfig storage cfg = _cfg[poolId];
        if (cfg.token == address(0)) revert UnknownPool();
        Round storage r = rounds[poolId];
        if (r.phase != 0) revert RoundActive();
        if (_lastStartBlock[poolId] == block.number) revert StartedThisBlock();
        _lastStartBlock[poolId] = block.number;

        // pull everything claimable into the pool's ETH pot first
        if (hook.pending(poolId) > 0 || hook.tab(poolId) > 0) {
            ethPot[poolId] += hook.claim(poolId); // paid in native ETH
        }
        uint256 pot = ethPot[poolId];
        // a round can also run on a carried pot alone (a zero-eligible round's
        // asset waiting to be redistributed) — but never on dust alone
        if (pot < MIN_ROUND_POT && !pendingCarry[poolId]) revert NothingToDistribute();
        pendingCarry[poolId] = false;

        // Capture eligibility before any dividend-asset conversion. For a
        // reflection route the swap itself moves the launched token, but those
        // newly bought distribution tokens must not alter holder weights.
        uint64 eligibilityCheckpoint = ILaypipeCheckpointToken(cfg.token).checkpointClock();

        uint256 converted = 0;
        uint256 bounty = 0;
        uint256 keeperReserve = 0;
        if (pot >= MIN_ROUND_POT) {
            uint256 chunk = pot > MAX_SWAP_PER_CALL ? MAX_SWAP_PER_CALL : pot;
            ethPot[poolId] = pot - chunk;
            bounty = (chunk * BOUNTY_BPS) / 10_000;
            keeperReserve = (chunk * KEEPER_RESERVE_BPS) / 10_000;
            uint256 spend = chunk - bounty - keeperReserve;
            if (cfg.route == Route.ETH) {
                assetPot[poolId] += spend;
                converted = spend;
            } else if (cfg.route == Route.V4) {
                uint256 balanceBefore = IERC20(cfg.dividendToken).balanceOf(address(this));
                if (cfg.v4InputIsWeth) weth.deposit{value: spend}();
                (, uint256 ethSpent) =
                    abi.decode(poolManager.unlock(abi.encode(cfg.v4Key, spend, cfg.v4InputIs0)), (uint256, uint256));
                if (cfg.v4InputIsWeth && ethSpent < spend) weth.withdraw(spend - ethSpent);
                // partial fill (price limit) leaves unspent ETH — back to the pot
                if (ethSpent < spend) ethPot[poolId] += spend - ethSpent;
                // Account only for tokens the distributor actually received.
                // A fee-on-transfer or otherwise unusual ERC-20 may deliver
                // less than the pool's nominal BalanceDelta.
                assetPot[poolId] += IERC20(cfg.dividendToken).balanceOf(address(this)) - balanceBefore;
                converted = ethSpent;
            } else if (cfg.route == Route.V3) {
                (uint256 out, uint256 ethSpent) = _buyV3(cfg, spend);
                assetPot[poolId] += out;
                // A v3 exact-input swap can stop at its price limit before
                // consuming the full amount. The callback's cumulative
                // allowance records exactly what the pool actually pulled;
                // keep the untouched ETH owned by this pool's next round.
                if (ethSpent < spend) ethPot[poolId] += spend - ethSpent;
                converted = ethSpent;
            } else {
                (uint256 out, uint256 ethSpent) = _buyAdapter(cfg, spend);
                assetPot[poolId] += out;
                if (ethSpent < spend) ethPot[poolId] += spend - ethSpent;
                converted = ethSpent;
            }
        }

        uint256 potAsset = assetPot[poolId];
        if (potAsset == 0) revert NothingToDistribute();
        if (potAsset > type(uint128).max) revert ValueTooLarge();
        assetPot[poolId] = 0;

        roundId = r.id + 1;
        roundCheckpoint[poolId][roundId] = eligibilityCheckpoint;
        uint256 enrollReserve = (keeperReserve * ENROLL_RESERVE_SHARE_BPS) / 10_000;
        uint256 finalizeReserve = (keeperReserve * FINALIZE_RESERVE_SHARE_BPS) / 10_000;
        enrollTipReserve[poolId][roundId] = enrollReserve;
        finalizeTipReserve[poolId][roundId] = finalizeReserve;
        payoutTipReserve[poolId][roundId] = keeperReserve - enrollReserve - finalizeReserve;
        r.id = roundId;
        r.phase = 1;
        r.enrollEnd = uint40(block.timestamp + ENROLL_WINDOW);
        r.count = 0;
        r.paidCursor = 0;
        r.potAsset = uint128(potAsset);
        r.totalEligible = 0;
        r.distributed = 0;

        if (bounty > 0) {
            _payKeeper(msg.sender, bounty);
        }
        emit RoundStarted(poolId, roundId, potAsset, converted, r.enrollEnd);
    }

    /// @notice Records holders for the open round. The contract reads every
    ///         balance from the token itself — submitted addresses can be
    ///         incomplete, never inflated. Pays the caller a flat tip per
    ///         newly-enrolled holder, from the pool's own fee pot.
    function enroll(PoolId poolId, address[] calldata holders) external nonReentrant {
        uint256 added = _enroll(poolId, holders);
        if (added > 0) {
            uint256 tip = added * TIP_PER_ENTRY;
            uint64 roundId = rounds[poolId].id;
            uint256 pot = enrollTipReserve[poolId][roundId];
            if (tip > pot) tip = pot;
            if (tip > 0) {
                enrollTipReserve[poolId][roundId] = pot - tip;
                _payKeeper(msg.sender, tip);
            }
        }
    }

    /// @notice Enroll yourself — the censorship escape hatch. No tip.
    function selfEnroll(PoolId poolId) external nonReentrant {
        address[] memory self = new address[](1);
        self[0] = msg.sender;
        _enrollMemory(poolId, self);
    }

    /// @notice Closes enrollment once the window has passed. An empty round
    ///         carries its pot to the next one instead of stranding it.
    function finalizeEnrollment(PoolId poolId) external nonReentrant {
        Round storage r = rounds[poolId];
        if (r.phase != 1) revert WrongPhase();
        if (block.timestamp <= r.enrollEnd) revert EnrollmentOpen();
        uint64 roundId = r.id;
        uint256 finalizerTip = finalizeTipReserve[poolId][roundId];
        finalizeTipReserve[poolId][roundId] = 0;
        if (r.count == 0 || r.totalEligible == 0) {
            assetPot[poolId] += r.potAsset;
            pendingCarry[poolId] = true; // a full pot, not dust — redistribute it
            r.phase = 0;
            emit RoundClosed(poolId, r.id, 0, r.potAsset);
            // With no payout phase, the finalizer also earns every unused
            // post-start reserve and prevents it becoming stranded ETH.
            finalizerTip += enrollTipReserve[poolId][roundId] + payoutTipReserve[poolId][roundId];
            enrollTipReserve[poolId][roundId] = 0;
            payoutTipReserve[poolId][roundId] = 0;
            if (finalizerTip > 0) _payKeeper(msg.sender, finalizerTip);
            return;
        }
        // Enrollment has closed. Any unused enrollment funding now rewards
        // payout callers, especially the caller that closes the round.
        payoutTipReserve[poolId][roundId] += enrollTipReserve[poolId][roundId];
        enrollTipReserve[poolId][roundId] = 0;
        r.phase = 2;
        emit RoundFinalized(poolId, r.id, r.count, r.totalEligible);
        if (finalizerTip > 0) _payKeeper(msg.sender, finalizerTip);
    }

    /// @notice Pays enrolled holders their pro-rata share, up to `maxEntries`
    ///         per call. Anyone can crank; each processed holder tips the
    ///         caller. A transfer that fails is skipped — its share carries to
    ///         the next round, and one poison recipient can never jam a round.
    function payout(PoolId poolId, uint256 maxEntries) external nonReentrant {
        PoolConfig storage cfg = _cfg[poolId];
        Round storage r = rounds[poolId];
        if (r.phase != 2) revert WrongPhase();
        if (maxEntries == 0) revert NothingToDistribute();

        address[] storage entries = _entries[poolId][r.id];
        uint256 end = r.paidCursor + maxEntries;
        if (end > r.count) end = r.count;
        uint256 processed = end - r.paidCursor;
        if (processed == 0) revert NothingToDistribute();

        uint256 distributedNow = 0;
        for (uint256 i = r.paidCursor; i < end; i++) {
            address holder = entries[i];
            uint256 share = (uint256(r.potAsset) * enrolledBalance[poolId][r.id][holder]) / r.totalEligible;
            if (share > 0 && _pay(cfg, holder, share)) {
                distributedNow += share;
            }
        }
        r.paidCursor = uint32(end);
        r.distributed += uint128(distributedNow);

        if (end == r.count) {
            // round complete: whatever wasn't (or couldn't be) paid carries
            uint256 carried = r.potAsset - r.distributed;
            assetPot[poolId] += carried;
            r.phase = 0;
            emit RoundClosed(poolId, r.id, r.distributed, carried);
        }

        uint256 tip = processed * TIP_PER_ENTRY;
        uint256 pot = payoutTipReserve[poolId][r.id];
        if (tip > pot) tip = pot;
        payoutTipReserve[poolId][r.id] = pot - tip;
        // The caller that completes the round receives the unused remainder,
        // so there is always an incentive to advance the final batch.
        if (end == r.count) {
            tip += payoutTipReserve[poolId][r.id];
            payoutTipReserve[poolId][r.id] = 0;
        }
        if (tip > 0) {
            _payKeeper(msg.sender, tip);
        }
    }

    // ————————————————————— internals —————————————————————

    function _enroll(PoolId poolId, address[] calldata holders) private returns (uint256 added) {
        (Round storage r, PoolConfig storage cfg) = _openRound(poolId);
        uint64 id = r.id;
        uint256 eligible = r.totalEligible;
        for (uint256 i = 0; i < holders.length; i++) {
            address holder = holders[i];
            if (_excludedHolder(holder) || enrolledBalance[poolId][id][holder] != 0) continue;
            uint256 bal = ILaypipeCheckpointToken(cfg.token).balanceOfAt(holder, roundCheckpoint[poolId][id]);
            if (bal == 0 || bal < cfg.minBalance) continue;
            _entries[poolId][id].push(holder);
            enrolledBalance[poolId][id][holder] = uint128(bal);
            eligible += bal;
            added++;
        }
        if (added > 0) {
            r.totalEligible = uint128(eligible);
            r.count += uint32(added);
            emit Enrolled(poolId, id, added, eligible);
        }
    }

    function _enrollMemory(PoolId poolId, address[] memory holders) private {
        (Round storage r, PoolConfig storage cfg) = _openRound(poolId);
        uint64 id = r.id;
        for (uint256 i = 0; i < holders.length; i++) {
            address holder = holders[i];
            if (_excludedHolder(holder) || enrolledBalance[poolId][id][holder] != 0) continue;
            uint256 bal = ILaypipeCheckpointToken(cfg.token).balanceOfAt(holder, roundCheckpoint[poolId][id]);
            if (bal == 0 || bal < cfg.minBalance) continue;
            _entries[poolId][id].push(holder);
            enrolledBalance[poolId][id][holder] = uint128(bal);
            r.totalEligible += uint128(bal);
            r.count += 1;
            emit Enrolled(poolId, id, 1, r.totalEligible);
        }
    }

    function _openRound(PoolId poolId) private view returns (Round storage r, PoolConfig storage cfg) {
        cfg = _cfg[poolId];
        if (cfg.token == address(0)) revert UnknownPool();
        r = rounds[poolId];
        if (r.phase != 1) revert NoActiveRound();
        if (block.timestamp > r.enrollEnd) revert EnrollmentClosed();
    }

    function _excludedHolder(address holder) private view returns (bool) {
        return holder == address(0) || holder == address(poolManager) || holder == address(this);
    }

    function _payKeeper(address to, uint256 amount) private {
        (bool paid,) = to.call{value: amount}("");
        if (!paid) revert PayFailed();
    }

    /// @dev Sends `amount` of the dividend asset with a hard gas cap, so a
    ///      poison recipient or poison asset wastes one slot, not the batch.
    function _pay(PoolConfig storage cfg, address to, uint256 amount) private returns (bool ok) {
        if (cfg.route == Route.ETH) {
            (ok,) = to.call{value: amount, gas: PAY_GAS_CAP}("");
        } else {
            bytes memory data;
            (ok, data) = cfg.dividendToken.call{gas: PAY_GAS_CAP}(abi.encodeCall(IERC20.transfer, (to, amount)));
            if (!ok) return false;
            if (data.length == 0) return true;
            if (data.length < 32) return false;
            uint256 returned;
            assembly ("memory-safe") {
                returned := mload(add(data, 0x20))
            }
            ok = returned == 1;
        }
    }

    // ————————————————————— the buys —————————————————————

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, uint256 ethIn, bool inputIs0) = abi.decode(data, (PoolKey, uint256, bool));
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: inputIs0,
                amountSpecified: -int256(ethIn),
                sqrtPriceLimitX96: inputIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int128 inputDelta = inputIs0 ? delta.amount0() : delta.amount1();
        int128 outputDelta = inputIs0 ? delta.amount1() : delta.amount0();
        if (inputDelta >= 0 || outputDelta <= 0) revert AdapterSwapFailed();
        uint256 out = uint256(uint128(outputDelta));
        uint256 ethSpent = uint256(uint128(-inputDelta));
        // Arbitrary v4 pools may have arbitrary hooks. Even if a hook changes
        // the swap delta, it can never make this pool settle more than the
        // bounded input assigned to its own round.
        if (ethSpent > ethIn) revert SwapInputTooHigh();
        Currency inputCurrency = inputIs0 ? key.currency0 : key.currency1;
        Currency outputCurrency = inputIs0 ? key.currency1 : key.currency0;
        inputCurrency.settle(poolManager, address(this), ethSpent, false);
        outputCurrency.take(poolManager, address(this), out, false);
        return abi.encode(out, ethSpent);
    }

    function _buyAdapter(PoolConfig storage cfg, uint256 ethIn) private returns (uint256 out, uint256 ethSpent) {
        uint256 assetBefore = IERC20(cfg.dividendToken).balanceOf(address(this));
        uint256 ethBefore = address(this).balance;
        (bool ok,) = address(cfg.adapter).call{value: ethIn}(
            abi.encodeCall(IDividendSwapAdapter.swap, (cfg.dividendToken, cfg.adapterData))
        );
        if (!ok) revert AdapterSwapFailed();
        uint256 assetAfter = IERC20(cfg.dividendToken).balanceOf(address(this));
        if (assetAfter <= assetBefore) revert AdapterSwapFailed();
        out = assetAfter - assetBefore;

        // The adapter never receives approval over distributor assets. It gets
        // only this pool's bounded input as call value. Any ETH it refunds is
        // measured and returned to this pool's own pot.
        uint256 balanceFloor = ethBefore - ethIn;
        uint256 refund = address(this).balance > balanceFloor ? address(this).balance - balanceFloor : 0;
        if (refund > ethIn) refund = ethIn;
        ethSpent = ethIn - refund;
    }

    function _buyV3(PoolConfig storage cfg, uint256 ethIn) private returns (uint256 out, uint256 ethSpent) {
        // WETH in, dividend token out; exact input, no price limit (bounded
        // by the chunk cap and the block gate instead). The callback is armed
        // ONLY for the duration of this exact call, and only for this pool.
        bool zeroForOne = !cfg.v3TokenIs0;
        uint256 balanceBefore = IERC20(cfg.dividendToken).balanceOf(address(this));
        _activeV3Pool = address(cfg.v3Pool);
        _activeV3Remaining = ethIn;
        cfg.v3Pool.swap(
            address(this),
            zeroForOne,
            int256(ethIn),
            zeroForOne ? MIN_SQRT_RATIO_PLUS_1 : MAX_SQRT_RATIO_MINUS_1,
            ""
        );
        ethSpent = ethIn - _activeV3Remaining;
        _activeV3Pool = address(0);
        _activeV3Remaining = 0;
        // Trust the balance delta we actually received, not a token's or
        // pool's nominal return value. This keeps accounting correct for
        // supported non-standard ERC-20 transfer behaviour.
        out = IERC20(cfg.dividendToken).balanceOf(address(this)) - balanceBefore;
    }

    /// @dev The v3 pool collects payment here. Authenticated against the swap
    ///      currently in flight — NOT a caller-supplied address — so it is
    ///      reachable only from the exact pool this contract is mid-swap with,
    ///      and can never pay out more than that swap's own input.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external override {
        if (_activeV3Pool == address(0) || msg.sender != _activeV3Pool) revert NotV3Pool();
        uint256 owed = uint256(amount0Delta > 0 ? amount0Delta : amount1Delta);
        uint256 remaining = _activeV3Remaining;
        if (owed > remaining) revert V3OwedTooHigh();
        // Consume the allowance before either external call. A hostile pool may
        // invoke the callback more than once, so bounding each call against the
        // original input is insufficient: all callbacks in this swap must share
        // one cumulative allowance.
        _activeV3Remaining = remaining - owed;
        weth.deposit{value: owed}();
        if (!weth.transfer(msg.sender, owed)) revert PayFailed();
    }

    // ————————————————————— views —————————————————————

    /// @notice Everything a UI needs to drive the crank: 0 = start a round,
    ///         1 = enroll, 2 = finalize, 3 = payout, 4 = nothing to do yet.
    function nextStep(PoolId poolId) external view returns (uint8) {
        if (_cfg[poolId].token == address(0)) return 4; // not a dividend pool
        Round storage r = rounds[poolId];
        if (r.phase == 1) return block.timestamp > r.enrollEnd ? 2 : 1;
        if (r.phase == 2) return 3;
        uint256 claimable = _claimableEth(poolId);
        if (claimable >= MIN_ROUND_POT || pendingCarry[poolId]) return 0;
        return 4;
    }

    /// @notice ETH accrued toward the next round (claimed and unclaimed). Zero
    ///         for a pool this distributor doesn't serve.
    function claimableOf(PoolId poolId) external view returns (uint256) {
        if (_cfg[poolId].token == address(0)) return 0;
        return _claimableEth(poolId);
    }

    /// @dev `pending` is the hook's total unswept trading fee, including the
    ///      platform share. claim() can pay this distributor only the pool's
    ///      creator/dividend share, plus any already-swept tab. Mirror the
    ///      hook's exact integer split so readiness and UI bounty estimates
    ///      cannot overstate what startRound can actually receive.
    function _claimableEth(PoolId poolId) private view returns (uint256) {
        (,, uint16 creatorFeeBps,,,,) = hook.poolConfigs(poolId);
        uint256 unsweptDividendShare = (hook.pending(poolId) * creatorFeeBps) / 10_000;
        return unsweptDividendShare + hook.tab(poolId) + ethPot[poolId];
    }

    function configOf(PoolId poolId) external view returns (PoolConfig memory) {
        return _cfg[poolId];
    }

    function entriesOf(PoolId poolId, uint64 roundId) external view returns (uint256) {
        return _entries[poolId][roundId].length;
    }

    receive() external payable {} // the hook pays claims in native ETH
}
