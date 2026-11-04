import crypto from "node:crypto";
import { config } from "./config.js";
import { q, updateChannel, type ChannelRow } from "./db.js";
import { emit } from "./events.js";
import { ZkCli } from "./zk/cli.js";
import { memo, type ZcashWallet } from "./zcash/adapter.js";

export class Orchestrator {
  zk = new ZkCli();
  height = 0;
  private watching = false;
  private cheating = new Set<string>();

  constructor(public customerWallet: ZcashWallet, public merchantWallet: ZcashWallet) {}

  async init() {
    await this.zk.setup();
    this.height = await this.merchantWallet.height().catch(() => 0);
    setInterval(() => this.tick().catch((e) => console.error("[watcher]", e.message)), config.pollMs).unref();
    setInterval(() => this.pollHeight(), 15_000).unref();
  }

  private async pollHeight() {
    try {
      const h = await this.merchantWallet.height();
      if (h !== this.height) { this.height = h; emit("chain.height", { height: h }); }
    } catch (e) { console.error("[height]", (e as Error).message); }
  }

  get(name: string): ChannelRow {
    const c = q.get.get(name);
    if (!c) throw httpErr(404, "unknown channel");
    return c;
  }

  // ---------- open ----------
  async createChannel(requestedZats?: number) {
    let amountZats = requestedZats ?? config.openZats;
    if (requestedZats === undefined) {
      // size the channel to what the customer can actually fund (leave room for the network fee)
      const bal = await this.customerWallet.balance().catch(() => null);
      const have = bal ? Math.max(bal.spendableZats, bal.totalZats) : 0;
      if (have > 2 * config.feeZats) amountZats = Math.min(amountZats, have - 2 * config.feeZats);
    }
    // a new open supersedes channels that were never funded
    for (const c of q.byStatus.all("awaiting_funds")) updateChannel(c.name, { status: "abandoned" });
    const units = Math.floor(amountZats / config.unitZats);
    if (units < 200) throw httpErr(400, `amount too small (min ${200 * config.unitZats} zats)`);
    const name = "c" + crypto.randomBytes(5).toString("hex");
    q.insertChannel.run({ name, channel_id: null, amount_zats: units * config.unitZats, cust_units: units, status: "initializing", now: Date.now() });
    emit("channel.created", { name, amount_zats: units * config.unitZats });
    try {
      // merchant's in-channel balance is 0: merchant contributes no on-chain funds.
      // libzkchannels enforces a dust minimum, so we give the merchant side the minimum.
      const { channelId, ms } = await this.zk.openInit(name, units, MERCH_MIN_UNITS);
      updateChannel(name, { channel_id: channelId, status: "awaiting_funds" });
      emit("channel.initialized", { name, channel_id: channelId, ms });
      return { name, channel_id: channelId, amount_zats: units * config.unitZats, merchant_address: await this.merchantWallet.address(), memo: memo("open", channelId) };
    } catch (e) {
      updateChannel(name, { status: "error", error: (e as Error).message });
      emit("channel.error", { name, error: (e as Error).message });
      throw e;
    }
  }

  /** customer wallet sends the REAL shielded funding tx to the merchant (memo = channel id) */
  async fund(name: string) {
    const c = this.get(name);
    if (c.status !== "awaiting_funds") throw httpErr(409, `channel is ${c.status}`);
    const to = await this.merchantWallet.address();
    const m = memo("open", c.channel_id!);
    const { txid } = await this.customerWallet.send(to, c.amount_zats, m);
    updateChannel(name, { status: "funding_sent", open_txid: txid });
    emit("channel.funding_sent", { name, txid, explorer: config.explorerTxUrl + txid });
    return { txid };
  }

  // ---------- watcher: merchant scans incoming notes for zklane:v1:open:<cid> ----------
  async tick() {
    if (this.watching) return;
    this.watching = true;
    try {
      const pending = [...q.byStatus.all("awaiting_funds"), ...q.byStatus.all("funding_sent")];
      if (!pending.length) return;
      await this.merchantWallet.sync();
      const tip = await this.merchantWallet.height();
      const notes = await this.merchantWallet.incomingSince(0);
      for (const c of pending) {
        const want = memo("open", c.channel_id!);
        const note = notes.find((n) => n.memo.trim() === want);
        if (!note) continue;
        const conf = note.height > 0 ? tip - note.height + 1 : 0;
        if (conf < config.minConf) { emit("channel.confirming", { name: c.name, txid: note.txid, conf }); continue; }
        if (note.zats < c.amount_zats) { console.warn(`[watcher] ${c.name}: underfunded ${note.zats} < ${c.amount_zats}`); continue; }
        updateChannel(c.name, { status: "funded", open_txid: note.txid, open_height: note.height });
        emit("channel.funded", { name: c.name, txid: note.txid, height: note.height, explorer: config.explorerTxUrl + note.txid });
        await this.activate(c.name, note.txid);
      }
    } finally { this.watching = false; }
  }

  private async activate(name: string, txid: string) {
    try {
      // the merchant marks the channel open against the real Zcash escrow txid
      await this.zk.activateUnlink(name, zcashTxidToLeHex(txid));
      updateChannel(name, { status: "open" });
      emit("channel.open", { name });
    } catch (e) {
      updateChannel(name, { status: "error", error: (e as Error).message });
      emit("channel.error", { name, error: (e as Error).message });
    }
  }

  // ---------- pay (off-chain, real ZK proof) ----------
  async pay(name: string, units: number, item = "item") {
    const c = this.get(name);
    if (c.status !== "open") throw httpErr(409, `channel is ${c.status}`);
    if (!Number.isInteger(units) || units <= 0) throw httpErr(400, "amount must be a positive integer (units)");
    const r = await this.zk.pay(name, units);
    if (!r.ok) {
      emit("payment.rejected", { amount_units: units, ms: r.ms });
      throw httpErr(402, "payment rejected by merchant (proof did not verify or insufficient balance)", r.out);
    }
    // merchant-side record: amount + timing only, no channel, no payer
    const info = q.insertPayment.run(units, item, Date.now(), r.ms);
    const n = Number(info.lastInsertRowid);
    emit("payment.received", { n, amount_units: units, amount_zats: units * config.unitZats, item, latency_ms: r.ms });
    return { receipt: n, latency_ms: r.ms };
  }

  // ---------- close (honest) ----------
  async close(name: string) {
    const c = this.get(name);
    if (c.status !== "open") throw httpErr(409, `channel is ${c.status}`);
    updateChannel(name, { status: "closing" });
    emit("channel.closing", { name });
    const cc = await this.zk.custClose(name);
    const v = await this.zk.merchClose(c.channel_id!, cc.file);
    if (v.verdict === "revoked") return this.recordCheat(name, cc.custBal, v.evidence);
    if (v.verdict === "invalid") { updateChannel(name, { status: "open" }); throw httpErr(400, "close message invalid"); }
    return this.refund(name, cc.custBal);
  }

  private async refund(name: string, custUnits: number) {
    const c = this.get(name);
    const refundZats = custUnits * config.unitZats - config.feeZats;
    const to = await this.customerWallet.freshAddress();
    try {
      const { txid } = await this.merchantWallet.send(to, refundZats, memo("close", c.channel_id!, String(custUnits)));
      updateChannel(name, { status: "closed", close_txid: txid, refund_zats: refundZats, final_cust_units: custUnits });
      emit("channel.closed", { name, txid, refund_zats: refundZats, cust_units: custUnits, explorer: config.explorerTxUrl + txid });
      return { verdict: "valid", refund_zats: refundZats, txid, refund_address: to };
    } catch (e) {
      updateChannel(name, { status: "open", error: (e as Error).message });
      emit("channel.error", { name, error: "refund failed: " + (e as Error).message });
      throw e;
    }
  }

  private recordCheat(name: string, claimedUnits: number, evidence: { rev_lock: string; rev_secret: string }) {
    updateChannel(name, { status: "open", cheat_evidence: JSON.stringify({ ...evidence, claimed_units: claimedUnits }) });
    emit("cheat.detected", { name, claimed_units: claimedUnits, claimed_zats: claimedUnits * config.unitZats, rev_lock: evidence.rev_lock, rev_secret: evidence.rev_secret });
    return { verdict: "revoked", refused: true, claimed_units: claimedUnits, evidence };
  }

  // ---------- cheat demo (SPEC-v1 §4.4) ----------
  async snapshot(name: string) {
    const c = this.get(name);
    if (c.status !== "open") throw httpErr(409, `channel is ${c.status}`);
    await this.zk.snapshotCustState(name, "old");
    const bal = await this.peekBalance(name);
    emit("cheat.snapshot", { name, cust_units: bal });
    return { snapshot: true, cust_units: bal };
  }

  /** restore the OLD (revoked) customer state and try to close with it */
  async cheatClose(name: string) {
    const c = this.get(name);
    if (c.status !== "open") throw httpErr(409, `channel is ${c.status}`);
    this.cheating.add(name);
    await this.zk.snapshotCustState(name, "honest");
    await this.zk.restoreCustState(name, "old");
    try {
      const cc = await this.zk.custClose(name, "cheat");
      emit("cheat.attempt", { name, claimed_units: cc.custBal });
      const v = await this.zk.merchClose(c.channel_id!, cc.file);
      if (v.verdict === "revoked") return this.recordCheat(name, cc.custBal, v.evidence);
      // not detected (e.g. snapshot == current state): don't refund in the demo path
      return { verdict: v.verdict, refused: false, note: "snapshot was not a revoked state (make a payment after snapshotting)" };
    } finally {
      // put the honest state back so the channel can still be closed properly
      await this.zk.restoreCustState(name, "honest");
      this.cheating.delete(name);
    }
  }

  /** customer's current balance (read from a dry-run close message; local only) */
  async peekBalance(name: string) {
    if (this.cheating.has(name)) throw httpErr(409, "cheat attempt in progress");
    const cc = await this.zk.custClose(name, "peek");
    return cc.custBal;
  }
}

export const MERCH_MIN_UNITS = Number(process.env.MERCH_MIN_UNITS ?? 0);

/** Zcash txids are displayed byte-reversed (like Bitcoin); escrow txid is passed little-endian */
export function zcashTxidToLeHex(txid: string) {
  return Buffer.from(txid, "hex").reverse().toString("hex");
}

export class HttpError extends Error { constructor(public status: number, msg: string, public detail?: string) { super(msg); } }
export const httpErr = (s: number, m: string, d?: string) => new HttpError(s, m, d);
