// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Ownable2StepUpgradeable} from
    "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardTransient} from
    "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {CurrencySettler} from "./lib/CurrencySettler.sol";
import {LiquidityAmounts} from "./lib/LiquidityAmounts.sol";
import {PipedogHook} from "./PipedogHook.sol";
import {LaypipeToken} from "./LaypipeToken.sol";
import {LaypipeSelfBurner} from "./LaypipeSelfBurner.sol";

/// @title LaypipeFactory
/// @notice Clean-room implementation of the public LetsCash launch-factory
///         interface. It launches immutable token clones, initializes and
///         one-sided-seeds a Uniswap v4 pool, permanently binds its fee stream,
///         and optionally executes the creator's first buy atomically.
/// @dev The factory is UUPS-upgradeable for future launch modes. Existing
///      tokens and pools are not: the token clone target is immutable in clone
///      bytecode, and the non-upgradeable hook enforces the liquidity lock and
///      per-pool fee configuration independently of future factory upgrades.
contract LaypipeFactory is
    Initializable,
    Ownable2StepUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardTransient,
    IUnlockCallback
{
    using CurrencySettler for Currency;
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant PIPS_PER_BP = 100;
    uint256 public constant FIXED_FEE_RATE = 10_000; // 1% in Uniswap pips
    uint256 public constant MAX_HOOK_FEE_RATE = 900_000;
    uint16 public constant CREATOR_FEE_BPS = 7_000; // 70% of the 1% fee
    uint8 public constant VANITY_SUFFIX = 0xcc;

    struct Socials {
        string telegram;
        string twitter;
        string discord;
        string website;
        string extra;
    }

    struct TokenParams {
        string name;
        string symbol;
        string logo;
        string description;
        string metadataURI;
        Socials socials;
        address creator;
    }

    struct LaunchConfig {
        uint256 supply;
        int24 tickSpacing;
        int24 startTick;
        uint16 creatorFeeBps;
        uint24 baseFeeRate;
        uint24 launchFeeRate;
        uint32 launchFeeDecay;
        bool enabled;
        bool selfBurn;
    }

    struct UnlockData {
        PoolKey key;
        address token;
        address firstBuyRecipient;
        uint256 supply;
        uint256 firstBuyIn;
        uint256 firstBuyMinOut;
        int24 startTick;
    }

    error LaunchPaused();
    error DividendModeUnderReview();
    error InvalidConfig();
    error DisabledConfig();
    error InvalidCreator();
    error InfrastructureNotReady();
    error NotPoolManager();
    error FirstBuySlippage();
    error EtherTransferFailed();
    error InvalidInfrastructure();
    error InvalidRounds();
    error TokenAddressCollision();
    error InvalidVanitySuffix(address predictedToken);
    error InvalidTokenOrdering(address predictedToken, address quoteToken);
    error QuoteAllowanceMismatch(uint256 expected, uint256 actual);
    error QuoteTransferMismatch(uint256 expected, uint256 actual);
    error SeedRequiresQuote();
    error ResidualQuoteBalance(uint256 expected, uint256 actual);
    error ValueTooLarge();
    error UpgradeRequiresLaunchPaused();

    /// @dev Signature intentionally matches the current LetsCash launch event
    ///      so existing indexers can map the Laypipe deployment by address.
    event TokenLaunched(
        address indexed token,
        address indexed creator,
        PoolId indexed poolId,
        uint256 configId,
        uint256 firstBuyIn,
        uint256 firstBuyOut,
        address hook,
        address feeRecipient
    );
    event LaunchFeeRouted(address indexed treasury, uint256 amount);
    event FirstBuyRefunded(address indexed creator, uint256 amount);
    event LaunchConfigAdded(uint256 indexed configId, LaunchConfig config);
    event LaunchConfigEnabled(uint256 indexed configId, bool enabled);
    event LaunchEnabledSet(bool enabled);
    event DividendLaunchEnabledSet(bool enabled);
    event HookSet(address indexed oldHook, address indexed newHook);
    event TokenImplementationSet(address indexed oldImplementation, address indexed newImplementation);
    event SelfBurnerSet(address indexed oldBurner, address indexed newBurner);
    event TreasurySet(address indexed oldTreasury, address indexed newTreasury);
    event LaunchFeeSet(uint256 oldFee, uint256 newFee);
    event LaunchLiquiditySeeded(
        PoolId indexed poolId,
        uint128 liquidity,
        uint256 tokenAmount,
        uint256 tokenDustBurned
    );
    event Swept(address indexed asset, address indexed recipient, uint256 amount);

    IPoolManager public poolManager;
    IERC20 public quoteToken;
    PipedogHook public hook;
    LaypipeToken public tokenImplementation;
    LaypipeSelfBurner public selfBurner;
    address public treasury;
    uint256 public launchFee;
    bool public launchEnabled;

    LaunchConfig[] private _launchConfigs;

    constructor() {
        _disableInitializers();
    }

    function initialize(
        IPoolManager poolManager_,
        IERC20 quoteToken_,
        address treasury_,
        address owner_,
        uint256 launchFee_
    ) external initializer {
        if (
            address(poolManager_) == address(0) || treasury_ == address(0)
                || owner_ == address(0)
                || address(poolManager_).code.length == 0
                || address(quoteToken_).code.length == 0
        ) revert InvalidInfrastructure();
        __Ownable_init(owner_);
        __Ownable2Step_init();
        poolManager = poolManager_;
        quoteToken = quoteToken_;
        treasury = treasury_;
        launchFee = launchFee_;
    }

    function launch(
        TokenParams calldata params,
        uint256 configId,
        uint256 firstBuyIn,
        uint256 firstBuyMinOut,
        bytes32 salt
    ) external nonReentrant returns (address token, PoolId poolId) {
        return _launch(
            params, configId, firstBuyIn, firstBuyMinOut, salt
        );
    }

    function _launch(
        TokenParams calldata params,
        uint256 configId,
        uint256 firstBuyIn,
        uint256 firstBuyMinOut,
        bytes32 salt
    ) private returns (address token, PoolId poolId) {
        if (!launchEnabled) revert LaunchPaused();
        if (configId >= _launchConfigs.length) revert InvalidConfig();
        LaunchConfig memory config = _launchConfigs[configId];
        if (!config.enabled) revert DisabledConfig();
        // Creator identity is earned by signing the launch. Launching from a
        // hot wallet and handing the stream to a Safe remains possible through
        // the hook's explicit updateCreator flow after launch.
        if (params.creator == address(0) || params.creator != msg.sender) {
            revert InvalidCreator();
        }
        if (
            address(hook) == address(0) || address(tokenImplementation) == address(0)
                || (config.selfBurn && address(selfBurner) == address(0))
        ) revert InfrastructureNotReady();
        _requireLiveBindings(config.selfBurn);

        bytes32 derivedSalt = _derivedSalt(params, configId, msg.sender, salt);
        address predictedToken = Clones.predictDeterministicAddress(
            address(tokenImplementation), derivedSalt
        );
        if (uint8(uint160(predictedToken)) != VANITY_SUFFIX) {
            revert InvalidVanitySuffix(predictedToken);
        }
        if (
            uint160(predictedToken) <= uint160(address(quoteToken))
        ) {
            revert InvalidTokenOrdering(
                predictedToken, address(quoteToken)
            );
        }

        uint256 quoteFloor =
            _pullQuoteExact(msg.sender, launchFee + firstBuyIn);
        token = Clones.cloneDeterministic(address(tokenImplementation), derivedSalt);
        if (token == address(0)) revert TokenAddressCollision();

        LaypipeToken.Socials memory socials = LaypipeToken.Socials({
            telegram: params.socials.telegram,
            twitter: params.socials.twitter,
            discord: params.socials.discord,
            website: params.socials.website,
            extra: params.socials.extra
        });
        LaypipeToken(token).initialize(
            LaypipeToken.TokenConfig({
                name: params.name,
                symbol: params.symbol,
                logo: params.logo,
                description: params.description,
                metadataURI: params.metadataURI,
                socials: socials,
                creator: params.creator,
                supply: config.supply,
                taxBps: uint24(
                    (uint256(config.baseFeeRate) + PIPS_PER_BP - 1) / PIPS_PER_BP
                )
            })
        );

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(quoteToken)),
            currency1: Currency.wrap(token),
            fee: 0,
            tickSpacing: config.tickSpacing,
            hooks: IHooks(address(hook))
        });
        poolId = key.toId();

        address feeRecipient =
            config.selfBurn ? address(selfBurner) : params.creator;
        hook.register(
            poolId,
            feeRecipient,
            config.creatorFeeBps,
            config.baseFeeRate,
            config.launchFeeRate,
            config.launchFeeDecay
        );
        poolManager.initialize(key, TickMath.getSqrtPriceAtTick(config.startTick));
        LaypipeToken(token).initializePool(PoolId.unwrap(poolId));

        if (config.selfBurn) selfBurner.register(poolId, key);

        (uint256 firstBuyOut, uint256 firstBuySpent) = abi.decode(
            poolManager.unlock(
                abi.encode(
                    UnlockData({
                        key: key,
                        token: token,
                        firstBuyRecipient: params.creator,
                        supply: config.supply,
                        firstBuyIn: firstBuyIn,
                        firstBuyMinOut: firstBuyMinOut,
                        startTick: config.startTick
                    })
                )
            ),
            (uint256, uint256)
        );

        uint256 dust = IERC20(token).balanceOf(address(this));
        if (dust > 0) LaypipeToken(token).burn(dust);

        if (firstBuySpent < firstBuyIn) {
            uint256 refund = firstBuyIn - firstBuySpent;
            _pushQuoteExact(params.creator, refund);
            emit FirstBuyRefunded(params.creator, refund);
        }
        _pushQuoteExact(treasury, launchFee);
        emit LaunchFeeRouted(treasury, launchFee);
        uint256 endingBalance = quoteToken.balanceOf(address(this));
        if (endingBalance != quoteFloor) {
            revert ResidualQuoteBalance(quoteFloor, endingBalance);
        }

        emit TokenLaunched(
            token,
            params.creator,
            poolId,
            configId,
            firstBuyIn,
            firstBuyOut,
            address(hook),
            feeRecipient
        );
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        UnlockData memory operation = abi.decode(data, (UnlockData));
        (uint128 liquidity, uint256 seededTokenAmount) = _seedLiquidity(operation);
        (uint256 firstBuyOut, uint256 firstBuySpent) =
            _executeFirstBuy(operation);
        uint256 dust = operation.supply - seededTokenAmount;
        emit LaunchLiquiditySeeded(operation.key.toId(), liquidity, seededTokenAmount, dust);
        return abi.encode(firstBuyOut, firstBuySpent);
    }

    function _seedLiquidity(UnlockData memory operation)
        private
        returns (uint128 liquidity, uint256 seededTokenAmount)
    {
        int24 tickLower = TickMath.minUsableTick(operation.key.tickSpacing);
        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(operation.startTick);
        liquidity =
            LiquidityAmounts.getLiquidityForAmount1(sqrtLower, sqrtUpper, operation.supply);
        if (
            liquidity == 0
                || uint256(liquidity) > uint256(uint128(type(int128).max))
        ) {
            revert ValueTooLarge();
        }

        (BalanceDelta liquidityDelta,) = poolManager.modifyLiquidity(
            operation.key,
            ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: operation.startTick,
                liquidityDelta: int256(uint256(liquidity)),
                salt: bytes32(0)
            }),
            ""
        );
        int128 amount0 = liquidityDelta.amount0();
        int128 amount1 = liquidityDelta.amount1();
        // Initial liquidity is launched-token-only. Any PIPEDOG delta means
        // the configured tick/range no longer describes the intended curve.
        if (amount0 != 0) revert SeedRequiresQuote();
        if (amount1 < 0) {
            seededTokenAmount = uint256(uint128(-amount1));
            operation.key.currency1.settle(
                poolManager, address(this), seededTokenAmount, false
            );
        } else if (amount1 > 0) {
            operation.key.currency1.take(
                poolManager, address(this), uint256(uint128(amount1)), false
            );
        }
    }

    function _executeFirstBuy(UnlockData memory operation)
        private
        returns (uint256 firstBuyOut, uint256 quoteSpent)
    {
        if (operation.firstBuyIn > 0) {
            if (operation.firstBuyIn > uint256(type(int256).max)) revert ValueTooLarge();
            BalanceDelta swapDelta = poolManager.swap(
                operation.key,
                SwapParams({
                    zeroForOne: true,
                    amountSpecified: -int256(operation.firstBuyIn),
                    sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
                }),
                ""
            );
            int128 swapAmount0 = swapDelta.amount0();
            int128 swapAmount1 = swapDelta.amount1();
            if (swapAmount0 >= 0 || swapAmount1 <= 0) revert FirstBuySlippage();
            quoteSpent = uint256(uint128(-swapAmount0));
            firstBuyOut = uint256(uint128(swapAmount1));
            if (firstBuyOut < operation.firstBuyMinOut) revert FirstBuySlippage();
            if (quoteSpent > operation.firstBuyIn) {
                revert FirstBuySlippage();
            }
            operation.key.currency0.settle(
                poolManager, address(this), quoteSpent, false
            );
            operation.key.currency1.take(
                poolManager, operation.firstBuyRecipient, firstBuyOut, false
            );
        } else if (operation.firstBuyMinOut != 0) {
            revert FirstBuySlippage();
        }
    }

    function predictTokenAddress(
        TokenParams calldata params,
        uint256 configId,
        address sender,
        bytes32 salt
    ) public view returns (address) {
        if (address(tokenImplementation) == address(0)) revert InfrastructureNotReady();
        return Clones.predictDeterministicAddress(
            address(tokenImplementation), _derivedSalt(params, configId, sender, salt)
        );
    }

    function mineSalt(
        TokenParams calldata params,
        uint256 configId,
        address sender,
        uint256 start,
        uint256 rounds
    ) external view returns (bytes32 salt, address token) {
        if (rounds == 0 || start > type(uint256).max - rounds) revert InvalidRounds();
        for (uint256 i = start; i < start + rounds; ++i) {
            salt = bytes32(i);
            token = predictTokenAddress(params, configId, sender, salt);
            if (
                uint8(uint160(token)) == VANITY_SUFFIX
                    && uint160(token) > uint160(address(quoteToken))
            ) return (salt, token);
        }
        return (bytes32(0), address(0));
    }

    function _derivedSalt(
        TokenParams calldata params,
        uint256 configId,
        address sender,
        bytes32 salt
    ) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                sender,
                configId,
                salt,
                keccak256(bytes(params.name)),
                keccak256(bytes(params.symbol)),
                params.creator
            )
        );
    }

    function launchConfigCount() external view returns (uint256) {
        return _launchConfigs.length;
    }

    function getLaunchConfig(uint256 configId) external view returns (LaunchConfig memory) {
        if (configId >= _launchConfigs.length) revert InvalidConfig();
        return _launchConfigs[configId];
    }

    function addLaunchConfig(LaunchConfig calldata config)
        external
        onlyOwner
        returns (uint256 configId)
    {
        _validateConfig(config);
        configId = _launchConfigs.length;
        _launchConfigs.push(config);
        emit LaunchConfigAdded(configId, config);
    }

    function setLaunchConfigEnabled(uint256 configId, bool enabled) external onlyOwner {
        if (configId >= _launchConfigs.length) revert InvalidConfig();
        LaunchConfig storage config = _launchConfigs[configId];
        if (enabled && !_isSupportedActiveConfig(config)) revert InvalidConfig();
        config.enabled = enabled;
        emit LaunchConfigEnabled(configId, enabled);
    }

    function setLaunchEnabled(bool enabled) external onlyOwner {
        if (enabled) _requireInfrastructure();
        launchEnabled = enabled;
        emit LaunchEnabledSet(enabled);
    }

    function setDividendLaunchEnabled(bool enabled) external onlyOwner {
        if (enabled) {
            // The carried-forward distributor relies on open enrollment and
            // cannot prove the submitted holder set is complete. New dividend
            // launches stay contractually closed until an audited replacement
            // with a complete-set/proof design ships in a future upgrade.
            revert DividendModeUnderReview();
        }
        emit DividendLaunchEnabledSet(enabled);
    }

    function dividendLaunchEnabled() external pure returns (bool) {
        return false;
    }

    function dividendDistributor() external pure returns (address) {
        return address(0);
    }

    function setHook(PipedogHook newHook) external onlyOwner {
        if (
            address(newHook).code.length == 0 || newHook.factory() != address(this)
                || address(newHook.poolManager()) != address(poolManager)
                || address(newHook.quoteToken()) != address(quoteToken)
                || newHook.treasury() != treasury
        ) revert InvalidInfrastructure();

        // The self-burner binds its hook immutably.
        // A hook rotation must never leave new launches pointing at helpers
        // that will claim against the old hook. Atomically pause launches and
        // clear those dependants; the owner can deploy/rebind replacements,
        // then explicitly re-enable the supported modes.
        if (address(hook) != address(0) && address(hook) != address(newHook)) {
            if (launchEnabled) {
                launchEnabled = false;
                emit LaunchEnabledSet(false);
            }
            if (address(selfBurner) != address(0)) {
                emit SelfBurnerSet(address(selfBurner), address(0));
                selfBurner = LaypipeSelfBurner(address(0));
            }
        }
        emit HookSet(address(hook), address(newHook));
        hook = newHook;
    }

    function setTokenImplementation(LaypipeToken newImplementation) external onlyOwner {
        if (address(newImplementation).code.length == 0) revert InvalidInfrastructure();
        emit TokenImplementationSet(address(tokenImplementation), address(newImplementation));
        tokenImplementation = newImplementation;
    }

    function setSelfBurner(LaypipeSelfBurner newBurner) external onlyOwner {
        if (
            address(newBurner).code.length == 0 || newBurner.factory() != address(this)
                || address(newBurner.hook()) != address(hook)
                || address(newBurner.poolManager()) != address(poolManager)
                || address(newBurner.quoteToken())
                    != address(quoteToken)
        ) revert InvalidInfrastructure();
        emit SelfBurnerSet(address(selfBurner), address(newBurner));
        selfBurner = newBurner;
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (
            newTreasury == address(0) || launchEnabled
                || (
                    address(hook) != address(0)
                        && hook.treasury() != newTreasury
                )
        ) revert InvalidInfrastructure();
        emit TreasurySet(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setLaunchFee(uint256 newFee) external onlyOwner {
        emit LaunchFeeSet(launchFee, newFee);
        launchFee = newFee;
    }

    /// @notice Recovers assets accidentally held by the factory itself.
    /// @dev PIPEDOG is protocol revenue and goes to treasury. Other ERC20s and
    ///      force-sent native currency go to the owner. This function cannot
    ///      reach PoolManager liquidity, hook claims, or user balances.
    function sweep(address asset) external onlyOwner nonReentrant {
        address recipient;
        uint256 amount;
        if (asset == address(0)) {
            recipient = owner();
            amount = address(this).balance;
            if (amount > 0) {
                (bool paid,) = payable(recipient).call{value: amount}("");
                if (!paid) revert EtherTransferFailed();
            }
        } else {
            recipient = asset == address(quoteToken)
                ? treasury
                : owner();
            amount = IERC20(asset).balanceOf(address(this));
            if (amount > 0) {
                if (asset == address(quoteToken)) {
                    _pushQuoteExact(recipient, amount);
                } else {
                    IERC20(asset).safeTransfer(recipient, amount);
                }
            }
        }
        emit Swept(asset, recipient, amount);
    }

    function _pullQuoteExact(address from, uint256 amount)
        private
        returns (uint256 floor)
    {
        uint256 approved =
            quoteToken.allowance(from, address(this));
        if (approved != amount) {
            revert QuoteAllowanceMismatch(amount, approved);
        }
        floor = quoteToken.balanceOf(address(this));
        if (amount == 0) return floor;
        quoteToken.safeTransferFrom(from, address(this), amount);
        uint256 received = quoteToken.balanceOf(address(this)) - floor;
        if (received != amount) {
            revert QuoteTransferMismatch(amount, received);
        }
    }

    function _pushQuoteExact(address recipient, uint256 amount) private {
        if (amount == 0) return;
        uint256 senderBefore = quoteToken.balanceOf(address(this));
        uint256 recipientBefore = quoteToken.balanceOf(recipient);
        quoteToken.safeTransfer(recipient, amount);
        uint256 sent =
            senderBefore - quoteToken.balanceOf(address(this));
        uint256 received =
            quoteToken.balanceOf(recipient) - recipientBefore;
        if (sent != amount || received != amount) {
            revert QuoteTransferMismatch(amount, received);
        }
    }

    function _requireInfrastructure() private view {
        if (
            address(hook) == address(0) || address(tokenImplementation) == address(0)
                || treasury == address(0) || hook.factory() != address(this)
                || address(hook.poolManager()) != address(poolManager)
                || address(hook.quoteToken()) != address(quoteToken)
                || hook.treasury() != treasury
        ) revert InfrastructureNotReady();
    }

    function _requireLiveBindings(bool needsSelfBurner) private view {
        _requireInfrastructure();
        if (
            needsSelfBurner
                && (
                    address(selfBurner) == address(0)
                        || selfBurner.factory() != address(this)
                        || address(selfBurner.hook()) != address(hook)
                        || address(selfBurner.poolManager())
                            != address(poolManager)
                        || address(selfBurner.quoteToken())
                            != address(quoteToken)
                )
        ) revert InfrastructureNotReady();
    }

    function _validateConfig(LaunchConfig calldata config) private pure {
        if (
            config.supply == 0 || config.supply > type(uint192).max
                || config.tickSpacing < TickMath.MIN_TICK_SPACING
                || config.tickSpacing > TickMath.MAX_TICK_SPACING
                || config.startTick <= TickMath.minUsableTick(config.tickSpacing)
                || config.startTick > TickMath.maxUsableTick(config.tickSpacing)
                || config.startTick % config.tickSpacing != 0
                || config.creatorFeeBps > BPS_DENOMINATOR
                || config.launchFeeRate > MAX_HOOK_FEE_RATE
                || config.baseFeeRate > config.launchFeeRate
        ) revert InvalidConfig();
        if (config.enabled && !_isSupportedActiveConfig(config)) revert InvalidConfig();
    }

    function _isSupportedActiveConfig(LaunchConfig memory config)
        private
        pure
        returns (bool)
    {
        return config.creatorFeeBps == CREATOR_FEE_BPS
            && config.baseFeeRate == FIXED_FEE_RATE
            && config.launchFeeRate == FIXED_FEE_RATE && config.launchFeeDecay == 0;
    }

    /// @dev An upgrade can affect every future launch and the proxy remains an
    ///      approved PIPEDOG spender between a user's approval and launch.
    ///      Requiring the public launch gate to be closed prevents an
    ///      operational upgrade from occurring while new calls are accepted.
    function _authorizeUpgrade(address) internal view override onlyOwner {
        if (launchEnabled) revert UpgradeRequiresLaunchPaused();
    }
}
