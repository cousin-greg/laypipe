// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {DN404Mirror} from "dn404/DN404Mirror.sol";

/// @title PipeDogsMirror
/// @notice ERC-721 mirror for LayPipe's automatic PipeDog collection.
/// @dev DN404 and DN404Mirror are MIT licensed, copyright (c) 2023 Pop Punk LLC.
contract PipeDogsMirror is DN404Mirror {
    constructor(address deployer) DN404Mirror(deployer) {}

    function name() public pure override returns (string memory) {
        return "PipeDogs";
    }

    function symbol() public pure override returns (string memory) {
        return "PIPEDOGNFT";
    }
}
