#!/usr/bin/env bash
# YOU run this (not the assistant). Restores your mainnet wallet as zkLane's CUSTOMER wallet.
# Seed comes from $ZINGO_SEED if set, else a hidden prompt. It is never put on the command line.
# Usage: bash scripts/restore-customer-mainnet.sh [birthday_height]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ZINGO="${ZINGO_BIN:-$ROOT/tools/zingolib/target/release/zingo-cli}"
DIR="$ROOT/data/wallet-customer-mainnet"
BDAY="${1:-}"
[ -e "$DIR/zingo-wallet.dat" ] && { echo "wallet already exists in $DIR"; exit 1; }
if [ -z "${ZINGO_SEED:-}" ]; then read -rsp "Seed phrase (hidden): " ZINGO_SEED; echo; fi
[ "$(wc -w <<<"$ZINGO_SEED")" -eq 24 ] || { echo "expected 24 words"; exit 1; }
[ -n "$BDAY" ] || read -rp "Wallet birthday height (Enter = 419200, full scan, slow): " BDAY
mkdir -p "$DIR"
echo "Restoring + syncing (mixnet bootstrap, then scan)…"
ZINGO_SEED="$ZINGO_SEED" "$ZINGO" --chain mainnet --remember-online --birthday "${BDAY:-419200}" \
  --data-dir "$DIR" --waitsync spendable_balance
"$ZINGO" --chain mainnet --data-dir "$DIR" --nosync balance
echo "Done. Customer wallet ready at $DIR"
