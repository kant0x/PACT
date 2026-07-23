# Arc Testnet deployment

The PACT contracts were deployed to Arc Testnet (`chainId 5042002`) using the
operator wallet kept in the ignored `contracts/.env` file. These are public
contract addresses; no private key or secret is stored here.

| Contract | Address |
|---|---|
| PACT DisputeModule | `0x90b2f789a54Ed15deE3a24e81fC6727aA70f20dc` |
| ReputationRegistry | `0x6519c710D091E9CC3120bF2527CC7594Ffa0442E` |
| StreamingVault | `0xE71D1BAE0732153b70b17144d1b858DB70856572` |
| Arc Testnet USDC | `0x3600000000000000000000000000000000000000` |

The existing handoff above predates the Training Ground points ledger. The
deployment script now also deploys `PlatformPoints` and records its address in
`contracts.deployments.json`; do not invent an address here until that
transaction has been executed. After deployment, set that address in the API
as `PLATFORM_POINTS_ADDRESS` and authorize the server-side scorer. Platform
Points are non-transferable testnet points, not USDC and not commercial Trust
Score.

Deployment transaction receipts:

- Registry writer authorization: `0x7bac3c70ef3789135e4472c3142e6b49b0b050cbf1e8ce9797191319f7a3f001`

The vault points to the PACT DisputeModule, and the module points back to the
vault. The vault is an authorized writer in the ReputationRegistry. The module
is an operator-controlled testnet relay: the off-chain Judge returns the fault
verdict, while the module applies the finalized slash policy once and blocks
replayed decision receipts.

Explorer links:

- [DisputeModule](https://testnet.arcscan.app/address/0x90b2f789a54Ed15deE3a24e81fC6727aA70f20dc)
- [ReputationRegistry](https://testnet.arcscan.app/address/0x6519c710D091E9CC3120bF2527CC7594Ffa0442E)
- [StreamingVault](https://testnet.arcscan.app/address/0xE71D1BAE0732153b70b17144d1b858DB70856572)
- [Writer authorization transaction](https://testnet.arcscan.app/tx/0x7bac3c70ef3789135e4472c3142e6b49b0b050cbf1e8ce9797191319f7a3f001)

This does not make the local SQLite demo state on-chain truth. Before accepting
real funds, use a separate operator/multisig, verify the source on the explorer,
connect event reconciliation, and run the production readiness checklist.
