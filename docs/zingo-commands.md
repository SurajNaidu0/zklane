# zingo-cli commands (verified 2026-11-04, zingolib main @ v8.0.0, built from source)

Build: `cargo build --release -p zingo-cli` and
`cargo build --release --package zingo-netutils --features nym --bin nym-proxy`
(nym-proxy must sit beside the zingo-cli binary).

## Gotchas discovered
- **No default testnet indexer.** Must pass `--server https://testnet.zec.rocks:443`.
  (`lightwalletd.testnet.electriccoin.co:9067` timed out.)
- **Mixnet is mandatory for any online session** (ADR 0024): without `nym-proxy` beside the binary
  it fails with `Mixnet Mode is required for a connected session`. Nym discovery is occasionally
  flaky (`discovery timed out after 15s`); just retry.
- First boot is offline; `--remember-online` or `--server` gives connectivity consent.
- One-shot calls take 20–170 s each (mixnet bootstrap + sync), so `src/zcash/zingo.ts` keeps a
  **persistent interactive session** per wallet and pipes commands over stdin (works without a TTY).
  Startup costs about 35 s once.
- `quicksend` is not available; use `send` then `confirm`.

## Invocation
```
zingo-cli --chain testnet --server https://testnet.zec.rocks:443 --data-dir <abs dir> [--waitsync] [COMMAND]
```

## Commands used by the adapter (help text verified)
| Adapter | Command | Output |
|---|---|---|
| height() | `height` | `{"height": 4581585}` |
| address() | `addresses` | `[{"encoded_address":"utest1…", "has_orchard":true, …}]` |
| freshAddress() | `new_address o` | new unified address (orchard receiver) |
| balance() | `spendable_balance`, `balance` | `{"spendable_balance": N}`; `balance` is non-JSON `total_<pool>_balance: N` lines |
| send() | `send <addr> <zats> "<memo>"` then `confirm` | `confirm` → `{"txids": ["…"]}` |
| incomingSince() | `messages` | `{"value_transfers":[{"txid","status":"confirmed|mempool|transmitted|calculated","blockheight","kind":"received|sent|…","value","memos":[…]}]}` |
| sync() | `sync run` (also `sync status`) | |

Captured real outputs: `test/fixtures/*.txt`.

## Wallets
- customer: `data/wallet-customer`, UA `utest15q9966sc6etdutq6e32d9490p0xn7lqjpv7np8xalms3hwnyz6h5f260ku4w32pykyrr0g7dg7ejq5mmw8vsr3gcwx77ckq2x5xngreh`
- merchant: `data/wallet-merchant`, UA `utest1jufrqnl8hd3fh2gvjvg34j3t8m26a37th8uaxd7uwrq6v087cvt34l6ap03n70z3ecy08xg5j732ev2y9lufugmyuxpnm7vr7y70r0ep`
