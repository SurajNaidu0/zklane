#!/usr/bin/env bash
# Send a shielded MAINNET Zcash transaction with zingo-cli.
# - Seed is read at a hidden prompt and passed to zingo-cli only via the ZINGO_SEED env var
#   (never on the command line / shell history / process list).
# - Shows the proposal (fee) and asks you to type YES before anything is transmitted.
# - The restored wallet lives in a fresh temp dir; you're offered to delete it at the end.
# Review before running. Usage: bash scripts/send-mainnet.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ZINGO="${ZINGO_BIN:-$ROOT/tools/zingolib/target/release/zingo-cli}"   # nym-proxy must sit beside it
[ -x "$ZINGO" ] || { echo "zingo-cli not found at $ZINGO"; exit 1; }

WDIR="$(mktemp -d "${TMPDIR:-/tmp}/zingo-mainnet.XXXXXX")"
FIFO="$WDIR/stdin.fifo"
echo "Wallet dir (temporary): $WDIR"

# ---- inputs ----
read -rp "Recipient address (u1… / zs1… / t1…): " TO
[[ "$TO" =~ ^(u1|zs1|t1|t3)[0-9a-zA-Z]+$ ]] || { echo "doesn't look like a mainnet address"; exit 1; }
read -rp "Amount in zatoshis (1 ZEC = 100000000): " ZATS
[[ "$ZATS" =~ ^[0-9]+$ ]] && [ "$ZATS" -gt 0 ] || { echo "amount must be a positive integer"; exit 1; }
read -rp "Memo (optional, shielded recipients only, no quotes): " MEMO
[[ "$MEMO" != *\"* ]] || { echo "memo must not contain double quotes"; exit 1; }
read -rp "Wallet birthday height (Enter = scan from Sapling activation 419200, slow): " BDAY
BDAY="${BDAY:-419200}"
read -rsp "Seed phrase (24 words, hidden): " SEED; echo
[ "$(wc -w <<<"$SEED")" -eq 24 ] || { echo "expected 24 words"; exit 1; }

# ---- 1) restore + full sync (one-shot) ----
echo; echo "Restoring wallet and syncing (mixnet bootstrap + scan; can take a few minutes)…"
ZINGO_SEED="$SEED" "$ZINGO" --chain mainnet --remember-online --birthday "$BDAY" \
  --data-dir "$WDIR" --waitsync spendable_balance
unset SEED
"$ZINGO" --chain mainnet --data-dir "$WDIR" --nosync balance

# ---- 2) interactive session: propose, review fee, confirm/decline ----
mkfifo "$FIFO"
"$ZINGO" --chain mainnet --data-dir "$WDIR" < "$FIFO" &
PID=$!
exec 3>"$FIFO"
cleanup(){ echo quit >&3 2>/dev/null || true; exec 3>&- || true; wait "$PID" 2>/dev/null || true; }
trap cleanup EXIT

echo "Proposing: send $ZATS zats to $TO"
if [ -n "$MEMO" ]; then echo "send $TO $ZATS \"$MEMO\"" >&3; else echo "send $TO $ZATS" >&3; fi
echo "(waiting for the proposal and fee to print above; the session needs ~30s to come online)"
sleep 45
echo
read -rp "Type YES to transmit, anything else to cancel: " ANS
if [ "$ANS" = "YES" ]; then
  echo confirm >&3
  echo "Transmitting… the txid will print as {\"txids\": [...]}"
  sleep 60
else
  echo decline >&3
  echo "Cancelled. Nothing was sent."
fi
cleanup; trap - EXIT

read -rp "Delete the temporary wallet dir $WDIR (contains the wallet keys)? [y/N] " DEL
[ "$DEL" = "y" ] && rm -rf "$WDIR" && echo "deleted." || echo "kept at $WDIR"
