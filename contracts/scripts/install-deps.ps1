param(
    [string]$Forge = "forge"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

& $Forge install --root $root --no-git `
    "forge-std=foundry-rs/forge-std@rev=bf647bd6046f2f7da30d0c2bf435e5c76a780c1b" `
    "dn404=Vectorized/dn404@rev=3397cb11558ac853912ee87871422b6a29c9d346" `
    "openzeppelin-contracts=OpenZeppelin/openzeppelin-contracts@rev=2d59c17d9f9ffac7ae721f8eb29aa9544daf558f" `
    "openzeppelin-contracts-upgradeable=OpenZeppelin/openzeppelin-contracts-upgradeable@rev=c2462606bc1322a80d742159b2ff2728b5f76ecd" `
    "uniswap-hooks=OpenZeppelin/uniswap-hooks@rev=acbd604c409a827f7f98c9517236da860c4fca1a" `
    "v3-core=Uniswap/v3-core@rev=e3589b192d0be27e100cd0daaf6c97204fdb1899" `
    "v4-core=Uniswap/v4-core@rev=a7cf038cd568801a79a9b4cf92cd5b52c95c8585"

if ($LASTEXITCODE -ne 0) {
    throw "forge install failed with exit code $LASTEXITCODE"
}

& $Forge build --root $root
if ($LASTEXITCODE -ne 0) {
    throw "forge build failed with exit code $LASTEXITCODE"
}
