# `@cogcoin/genesis`

`@cogcoin/genesis@1.0.0` is the canonical artifact bundle for developers building Cogcoin indexers, verifiers, and other protocol tooling. It extends the on-chain trust chain rooted in the GENESIS transaction at Bitcoin block `937337` to every consensus-critical artifact needed for offline verification.

Use this package as the local source of truth for genesis artifacts. Install it, run verification, then load the included files directly.

## Links

- Website: [cogcoin.org](https://cogcoin.org)
- Whitepaper: [cogcoin.org/whitepaper.md](https://cogcoin.org/whitepaper.md)
- Genesis transaction: [block 937,337](https://mempool.space/tx/7258ebf6d45f13d46024ed00e5c21937a6e54f6a0f88afa96156ee4a6c4b667d)
- Source: [github.com/cogcoin](https://github.com/cogcoin)

## Quick Start

Install the package:

```bash
npm install @cogcoin/genesis
```

Then, from your project root, run:

```bash
node node_modules/@cogcoin/genesis/verify.mjs
```

Run verification before using the package in an implementation.

## Contents

- `LICENSE`: MIT license text shipped with the package
- `genesis_tx.json`: raw GENESIS transaction plus explicit treasury script bytes
- `genesis_params.json`: byte-exact parameters file committed on-chain by SHA-256
- `genesis_announcement.json` and `genesis_announcement.sig`: signed package trust extension
- `canonical_constants.json`: consensus-critical constants not present in `genesis_params.json`
- `bip39_english.txt`: pinned BIP-39 English wordlist
- `scoring_bundle/*`: scoring bundle committed by `genesis_params.json -> scoring_bundle_sha256`
- `cogcoin_whitepaper.md`: authoritative protocol specification
- `verify.mjs`: self-contained package verifier

## Trust Chain

1. The GENESIS transaction OP_RETURN commits the SHA-256 of `genesis_params.json`.
2. `genesis_params.json` commits `scoring_bundle/manifest.sha256` via `scoring_bundle_sha256`.
3. `genesis_pubkey` in `genesis_params.json` identifies the same key as the treasury recipient in `genesis_tx.json`.
4. That key signs the SHA-256 hash of `genesis_announcement.json`, and the announcement's `package_manifest` commits the signed package artifacts by SHA-256.

The signed package manifest excludes `genesis_announcement.json`, `genesis_announcement.sig`, `README.md`, and `package.json`. `LICENSE` is also shipped outside the signed set as package/legal metadata. The package is immutable. The trust model is the Bitcoin anchor plus the signed manifest, not the npm registry.

## Verification

Verify the installed package before using any artifact:

```bash
node node_modules/@cogcoin/genesis/verify.mjs
```

If you are already inside the package directory itself, `npm run verify` runs the same verifier.

The verifier checks:

- the on-chain `genesis_params.json` hash commitment
- the scoring bundle manifest and all scoring bundle artifact hashes
- every hash listed in `genesis_announcement.json -> package_manifest`
- the GENESIS txid and OP_RETURN payload
- treasury address, scriptPubKey, and pubkey-derived address consistency
- the Bitcoin message signature over the SHA-256 hash of `genesis_announcement.json`

Run the verifier after installation. If verification fails, do not use the package artifacts.

## Critical Clarifications

- `bootstrap_award_per_registration_cogtoshi` applies at `DOMAIN_ANCHOR`, not `DOMAIN_REG`. The genesis parameter key name is a locked on-chain misnomer.
- The scoring WASM export `settle_block_wasm` is non-consensus. Use the WASM bundle for scoring only, and implement settlement per Sections 5.1.2-5.1.5 of `cogcoin_whitepaper.md`.

## Signature

`genesis_announcement.sig` contains the Bitcoin message signature over the SHA-256 hash of `genesis_announcement.json`. The verifier checks that signature together with the package manifest, transaction data, and on-chain anchors.
