# Vendored IDLs: provenance

These files are byte-for-byte copies of pump.fun's official Anchor IDLs. They are used **only to decode events**. Nothing in this project builds, signs or sends instructions.

## Pinned (used by the decoder)

| File | Program ID | Source | Bytes | SHA-256 |
| --- | --- | --- | --- | --- |
| `pump.json` | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | `src/idl/pump.json` in npm `@pump-fun/pump-sdk@4.3.1` | 329083 | `c53b8f5d39887afd27cc40a256527a421c2d91b64a9014dc4952a261f4f36a01` |
| `pump_amm.json` | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` | `src/idl/pump_amm.json` in npm `@pump-fun/pump-sdk@4.3.1` (byte-identical in `@pump-fun/pump-swap-sdk@2.2.0`) | 192409 | `c2f8ce0bc0a740d9125644b2d95494c97199fce1604802f5ab0497184bdcce61` |

**Package details**

| Package | Published (UTC) | Repository | npm integrity |
| --- | --- | --- | --- |
| `@pump-fun/pump-sdk@4.3.1` | 2026-10-22T13:47:22Z | `github.com/pump-fun/pump-sdk` | `sha512-C39JUoafBMTwv9sKOGxJFakFypsH/C8VJs54xde1Rl1C9Z10i+XMdAJrYMk3CKPUd41RUMu/pM834GUMuOewVA==` |
| `@pump-fun/pump-swap-sdk@2.2.0` | 2026-10-19T14:19:05Z | `github.com/pump-fun/pump-swap-sdk` | `sha512-YGHDcLexyL6/N8lDcLMmFBX6o5l7X0Nxqf2kzjRJ96plLatFZ9LXNJZErdl9yySe3dpKpO+/nzQHL4dHtL7nmQ==` |

- Fetched on 2026-10-29. The tarballs were downloaded as data and extracted only; no package code was installed or run.
- Both IDLs use the Anchor IDL spec `0.1.0`, and both report version `0.1.0`.
- `src/onchain/idl.ts` checks both SHA-256 values at load time and refuses to decode if either file was changed.

## Why these and not the docs repository

| Step | What it showed |
| --- | --- |
| First pins | The first pins were the latest IDLs in `github.com/pump-fun/pump-public-docs`: commit `639b87f` (pump, 2026-10-13) and commit `8cda1fa` (pump_amm, 2026-10-07). They are kept in `superseded/` for reference. |
| Read-only probe (2026-10-29) | Probed against public mainnet RPC. With the first pins, every sampled live `TradeEvent`, `BuyEvent` and `SellEvent` decoded all of its declared fields and then had exactly **8 unknown trailing bytes**. |
| SDK comparison | The newer official SDK IDLs append one field to each of those three events: `quote_transfer_fee: u64`, as the last field. The SDK source describes it as the quote mint's Token-2022 transfer fee; it was 0 on the sampled SOL-quoted trades. No other event layout differs. |
| After re-pinning | With these pins, the sampled live events decode exactly, with no trailing bytes. The sample is small and was not stored. |

## Updating

1. Download the new official files.
2. Update the table above and `PINNED_IDLS` in `idl.ts`.
3. Bump `DECODER_VERSION`.

Existing rows keep their old `decoder_version`.

## Event discriminators used

Each discriminator below equals the first 8 bytes of `sha256("event:<Name>")`. `idl.ts` re-checks this at load time.

| Program | Event | Discriminator (hex) |
| --- | --- | --- |
| pump | `CreateEvent` | `1b72a94ddeeb6376` |
| pump | `TradeEvent` | `bddb7fd34ee661ee` |
| pump | `CompleteEvent` | `5f72619cd42e9808` |
| pump | `CompletePumpAmmMigrationEvent` | `bde95db95c94ea94` |
| pump_amm | `BuyEvent` | `67f4521f2cf57777` |
| pump_amm | `SellEvent` | `3e2f370aa503dc2a` |
| pump_amm | `CreatePoolEvent` | `b1310cd2a076a774` |
