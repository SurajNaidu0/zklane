import path from "node:path";
import fs from "node:fs";

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// tiny .env loader (no dependency)
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const env = (k: string, d: string) => process.env[k] ?? d;
const num = (k: string, d: number) => Number(process.env[k] ?? d);

export const config = {
  zcashMode: env("ZCASH_MODE", "mock") as "real" | "mock",
  port: num("PORT", 8787),
  dataDir: path.resolve(ROOT, env("DATA_DIR", "data")),
  zkBin: path.resolve(ROOT, env("ZK_BIN", "libzkchannels/target/release/zkchannels-cli")),
  redisPort: num("REDIS_PORT", 6390),
  merchDb: num("MERCH_REDIS_DB", 1),
  custDb: num("CUST_REDIS_DB", 2),
  merchPort: num("ZK_MERCH_PORT", 12347),
  custPort: num("ZK_CUST_PORT", 12346),
  // 1 channel unit = UNIT_ZATS zatoshis (SPEC-v1 §2: 1 unit = 0.0001 ZEC)
  unitZats: num("UNIT_ZATS", 10_000),
  openZats: num("OPEN_ZATS", 10_000_000), // 0.1 ZEC = 1000 units
  feeZats: num("FEE_ZATS", 10_000),
  minConf: num("MIN_CONF", 1),
  pollMs: num("WATCH_POLL_MS", 10_000),
  zingoBin: env("ZINGO_BIN", path.join(ROOT, "tools/zingolib/target/release/zingo-cli")),
  lightwalletd: env("LIGHTWALLETD", ""),
  merchantWalletDir: path.resolve(ROOT, env("MERCHANT_WALLET_DIR", "data/wallet-merchant")),
  customerWalletDir: path.resolve(ROOT, env("CUSTOMER_WALLET_DIR", "data/wallet-customer")),
  explorerTxUrl: env("EXPLORER_TX_URL", "https://testnet.zcashexplorer.app/transactions/"),
  mockBlockMs: num("MOCK_BLOCK_MS", 5_000),
};

export const zatsToZec = (z: number) => (z / 1e8).toFixed(4);
