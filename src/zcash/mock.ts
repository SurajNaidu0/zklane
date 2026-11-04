// ZCASH_MODE=mock: fake chain with the same interface. Clearly labelled "mock" in the UI.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingNote, ZcashWallet } from "./adapter.js";
import { config } from "../config.js";

interface MockTx { txid: string; to: string; zats: number; memo: string; height: number }

class MockChain {
  file = path.join(config.dataDir, "mock-chain.json");
  state: { height: number; txs: MockTx[]; balances: Record<string, number> };
  constructor() {
    this.state = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, "utf8"))
      : { height: 3_100_000, txs: [], balances: { customer: 50_000_000, merchant: 5_000_000 } };
    setInterval(() => { this.state.height++; this.save(); }, config.mockBlockMs).unref();
  }
  save() { fs.mkdirSync(config.dataDir, { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.state)); }
}
let chain: MockChain | null = null;

export class MockWallet implements ZcashWallet {
  constructor(public readonly name: "customer" | "merchant") { chain ??= new MockChain(); }
  private get c() { return chain!; }
  async sync() {}
  async height() { return this.c.state.height; }
  async address() { return `utest1mock${this.name}${"0".repeat(20)}`; }
  async freshAddress() { return `utest1mock${this.name}${crypto.randomBytes(10).toString("hex")}`; }
  async balance() { const b = this.c.state.balances[this.name] ?? 0; return { spendableZats: b, totalZats: b }; }
  async send(to: string, zats: number, memo: string) {
    const bal = this.c.state.balances[this.name] ?? 0;
    if (bal < zats + config.feeZats) throw new Error(`mock ${this.name}: insufficient funds`);
    this.c.state.balances[this.name] = bal - zats - config.feeZats;
    const other = this.name === "customer" ? "merchant" : "customer";
    if (to.includes(`mock${other}`)) this.c.state.balances[other] = (this.c.state.balances[other] ?? 0) + zats;
    // mined in the next mock block
    const tx = { txid: crypto.randomBytes(32).toString("hex"), to, zats, memo, height: this.c.state.height + 1 };
    this.c.state.txs.push(tx); this.c.save();
    return { txid: tx.txid };
  }
  async incomingSince(h: number): Promise<IncomingNote[]> {
    return this.c.state.txs
      .filter((t) => t.to.includes(`mock${this.name}`) && t.height > h && t.height <= this.c.state.height)
      .map(({ txid, zats, memo, height }) => ({ txid, zats, memo, height }));
  }
}
