#!/usr/bin/env bash
# One-shot setup from a fresh clone: builds libzkchannels (ZK mode, patched) + node deps + redis.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
if [ ! -d libzkchannels ]; then
  git clone https://github.com/boltlabs-inc/libzkchannels.git
  (cd libzkchannels && git apply ../libzkchannels-zkmode.patch && git apply ../libzkchannels-zklane.patch \
    && echo 'fn main(){}' > build.rs && cargo update -p num-bigint@0.4.0 --precise 0.4.6)
fi
(cd libzkchannels && RUSTFLAGS=-Awarnings cargo build --release --bin zkchannels-cli)
npm install
scripts/redis.sh
echo "Ready. Mock demo: ZCASH_MODE=mock npm start  ->  http://localhost:8787   (then: scripts/demo.sh)"
