// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IUniswapV3SwapCallback} from
    "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";

contract MockERC20 is ERC20 {
    constructor(string memory name_, string memory symbol_)
        ERC20(name_, symbol_)
    {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockWETH is MockERC20 {
    constructor() MockERC20("Wrapped Ether", "WETH") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    receive() external payable {
        _mint(msg.sender, msg.value);
    }
}

contract MockV3Factory {
    address public tokenA;
    address public tokenB;
    uint24 public fee;
    address public pool;

    function configure(
        address tokenA_,
        address tokenB_,
        uint24 fee_,
        address pool_
    ) external {
        tokenA = tokenA_;
        tokenB = tokenB_;
        fee = fee_;
        pool = pool_;
    }

    function getPool(address a, address b, uint24 requestedFee)
        external
        view
        returns (address)
    {
        bool pair =
            (a == tokenA && b == tokenB) || (a == tokenB && b == tokenA);
        return pair && requestedFee == fee ? pool : address(0);
    }
}

contract MockV3Pool {
    enum Mode {
        NORMAL,
        OVERCHARGE,
        DOUBLE_CALLBACK,
        WRONG_SIGN,
        RETURN_MISMATCH,
        EMPTY_OUTPUT
    }

    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    address public immutable factory;
    MockERC20 public immutable outputToken;
    bool public immutable wethIsToken0;
    Mode public mode;

    constructor(
        address token0_,
        address token1_,
        uint24 fee_,
        address factory_,
        MockERC20 outputToken_,
        bool wethIsToken0_
    ) {
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
        factory = factory_;
        outputToken = outputToken_;
        wethIsToken0 = wethIsToken0_;
    }

    function setMode(Mode newMode) external {
        mode = newMode;
    }

    function swap(
        address recipient,
        bool,
        int256 amountSpecified,
        uint160,
        bytes calldata
    ) external returns (int256 amount0, int256 amount1) {
        require(amountSpecified > 0, "exact input only");
        uint256 requested = uint256(amountSpecified);
        uint256 output = mode == Mode.EMPTY_OUTPUT ? 0 : requested * 2;

        if (mode == Mode.OVERCHARGE) {
            _callback(msg.sender, requested + 1, output);
        } else if (mode == Mode.DOUBLE_CALLBACK) {
            _callback(msg.sender, requested / 2, output);
            _callback(msg.sender, requested, output);
        } else if (mode == Mode.WRONG_SIGN) {
            if (wethIsToken0) {
                IUniswapV3SwapCallback(msg.sender).uniswapV3SwapCallback(
                    int256(requested), 0, ""
                );
            } else {
                IUniswapV3SwapCallback(msg.sender).uniswapV3SwapCallback(
                    0, int256(requested), ""
                );
            }
        } else {
            _callback(msg.sender, requested, output);
        }

        if (output > 0) outputToken.transfer(recipient, output);
        uint256 returnedInput =
            mode == Mode.RETURN_MISMATCH ? requested - 1 : requested;
        if (wethIsToken0) {
            return (int256(returnedInput), -int256(output));
        }
        return (-int256(output), int256(returnedInput));
    }

    function _callback(address caller, uint256 owed, uint256 output) private {
        if (wethIsToken0) {
            IUniswapV3SwapCallback(caller).uniswapV3SwapCallback(
                int256(owed), -int256(output), ""
            );
        } else {
            IUniswapV3SwapCallback(caller).uniswapV3SwapCallback(
                -int256(output), int256(owed), ""
            );
        }
    }
}

contract RejectNative {
    receive() external payable {
        revert("no");
    }
}
