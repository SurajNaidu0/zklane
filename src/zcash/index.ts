import { config } from "../config.js";
import type { ZcashWallet } from "./adapter.js";
import { MockWallet } from "./mock.js";

export async function makeWallets(): Promise<{ customer: ZcashWallet; merchant: ZcashWallet }> {
  if (config.zcashMode === "real") {
    const { ZingoWallet } = await import("./zingo.js");
    return {
      customer: new ZingoWallet("customer", config.customerWalletDir),
      merchant: new ZingoWallet("merchant", config.merchantWalletDir),
    };
  }
  return { customer: new MockWallet("customer"), merchant: new MockWallet("merchant") };
}
