#!/usr/bin/env bash
# End-to-end: open -> fund (Zcash) -> watcher activates -> N ZK payments -> cheat attempt -> honest close + refund
# Works for ZCASH_MODE=mock and real (server must already be running).
set -euo pipefail
API=${API:-http://localhost:8787}
PAYS=${PAYS:-5}
post(){ local body='{}'; [ $# -ge 2 ] && body="$2"; curl -s -X POST -H 'content-type: application/json' "$API$1" -d "$body"; }
get(){ curl -s "$API$1"; }
jget(){ python3 -c "import json,sys;d=json.load(sys.stdin);print(d$1)"; }

echo "== mode: $(get /api/status | jget "['mode']")"
R=$(post /api/channels '{}'); echo "$R"
N=$(echo "$R" | jget "['name']"); CID=$(echo "$R" | jget "['channel_id']")
echo "== channel $N  zkChannels id 0x$CID"

echo "== funding (shielded tx, memo zklane:v1:open:<cid>)"; post /api/channels/$N/fund; echo
for i in $(seq 1 120); do
  S=$(get /api/channels/$N | jget "['status']")
  [ "$S" = open ] && break
  [ "$S" = error ] && { get /api/channels/$N; exit 1; }
  sleep 5; post /api/watch >/dev/null || true
done
echo "== status: $S  open_txid: $(get /api/channels/$N | jget "['open_txid']")"

echo "== 2 payments, then snapshot state (for cheat demo)"
post /api/channels/$N/pay '{"amount":10,"item":"coffee"}'; echo
post /api/channels/$N/pay '{"amount":25,"item":"api-call"}'; echo
post /api/channels/$N/snapshot; echo
echo "== $PAYS more payments"
for i in $(seq 1 $PAYS); do post /api/channels/$N/pay "{\"amount\":5,\"item\":\"tick$i\"}"; echo; done
echo "== overspend should be rejected"
post /api/channels/$N/pay '{"amount":99999}'; echo

echo "== cheat: close with the OLD (revoked) state"
post /api/channels/$N/cheat-close; echo
echo "== honest close + refund"
post /api/channels/$N/close; echo
get /api/channels/$N; echo
echo "== merchant's payment log (note: no payer/channel column)"
get /api/merchant/payments | python3 -m json.tool | head -40
