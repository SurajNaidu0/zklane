// manual live check: npx tsx test/zingo-live.ts
process.env.LIGHTWALLETD ??= "https://testnet.zec.rocks:443";
const { ZingoWallet } = await import("../src/zcash/zingo.js");
const { config } = await import("../src/config.js");
const w = new ZingoWallet("customer", config.customerWalletDir);
const t = Date.now();
console.log("height", await w.height(), `${Date.now() - t}ms`);
console.log("address", await w.address());
console.log("balance", await w.balance(), `${Date.now() - t}ms`);
console.log("incoming", await w.incomingSince(0));
process.exit(0);
