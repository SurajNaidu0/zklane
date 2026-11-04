#!/usr/bin/env bash
# Milestone A: raw zkchannels-cli session (customer <-> merchant over TCP, state in Redis)
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
B="$ROOT/libzkchannels/target/release/zkchannels-cli"
OUT="${1:-$ROOT/data/cli-session}"; mkdir -p "$OUT"; cd "$OUT"
M=(--party MERCH --own-port 12347 --other-port 12346)
C=(--party CUST --own-port 12346 --other-port 12347)
MD=redis://127.0.0.1:6390/1; CD=redis://127.0.0.1:6390/2
NAME="chan$RANDOM"
ms(){ python3 -c 'import time;print(int(time.time()*1000))'; }
step(){ local name=$1; shift
  ZKLANE_DB_URL=$MD "$B" $name "${M[@]}" ${MEXTRA:-} > m_$name.log 2>&1 & local MP=$!; sleep 0.4
  local s=$(ms); ZKLANE_DB_URL=$CD "$B" $name "${C[@]}" "$@" > c_$name.log 2>&1; local rc=$?
  echo "== $name rc=$rc $(( $(ms)-s ))ms"; sleep 0.2; kill $MP 2>/dev/null; wait $MP 2>/dev/null; }
ZKLANE_DB_URL=$MD "$B" setfees >/dev/null; ZKLANE_DB_URL=$CD "$B" setfees >/dev/null
step open -n $NAME -c 1000 -m 1000
step init -n $NAME -a 2010 -o 2000
grep 'Channel id' c_init.log
MEXTRA="--escrow-txid $(printf 'ab%.0s' {1..32})" step activate -n $NAME
grep escrow m_activate.log
step unlink -n $NAME
ZKLANE_DB_URL=$MD "$B" pay "${M[@]}" > m_pay.log 2>&1 & MP=$!; sleep 0.4
for a in 10 25 5; do s=$(ms); ZKLANE_DB_URL=$CD "$B" pay "${C[@]}" -n $NAME -a $a > c_pay_$a.log 2>&1; echo "pay $a rc=$? $(( $(ms)-s ))ms"; done
kill $MP; wait $MP 2>/dev/null
grep -h 'valid pay' m_pay.log
ZKLANE_DB_URL=$CD "$B" close --party CUST -n $NAME --file cust_close.json > c_close.log 2>&1; echo "cust close rc=$?"
