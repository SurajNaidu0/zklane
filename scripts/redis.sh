#!/usr/bin/env bash
# dedicated Redis for zkLane's zkchannels-cli state (merchant=db1, customer=db2)
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; mkdir -p "$ROOT/data/redis"
redis-cli -p ${REDIS_PORT:-6390} ping >/dev/null 2>&1 || redis-server --port ${REDIS_PORT:-6390} --dir "$ROOT/data/redis" --appendonly yes --save "" --daemonize yes
redis-cli -p ${REDIS_PORT:-6390} ping
