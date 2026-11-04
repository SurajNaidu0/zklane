// ZCASH_MODE=real — zingo-cli (zingolib v8) on ZCASH_CHAIN (testnet default, or mainnet).
// Each one-shot zingo-cli call re-bootstraps the Nym mixnet + syncs (20–170 s), so we keep ONE
// long-lived interactive session per wallet and pipe commands over stdin.
// Delimiting: after each command we send an unknown command `zkmark_<n>`; zingo prints
// "unrecognized subcommand 'zkmark_<n>'" on stderr once the previous command's stdout is out.
// Exact commands are documented in docs/zingo-commands.md.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import type { IncomingNote, ZcashWallet } from "./adapter.js";
import { config } from "../config.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class ZingoSession {
  private p: ChildProcess | null = null;
  private out = "";
  private err = "";
  private n = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private starting: Promise<void> | null = null;

  constructor(private name: string, private dir: string) {}

  private start(): Promise<void> {
    if (this.p && this.p.exitCode === null) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = (async () => {
      fs.mkdirSync(this.dir, { recursive: true });
      // --remember-online = connectivity consent (first boot is offline otherwise)
      const args = ["--chain", config.zcashChain, "--data-dir", this.dir, "--remember-online"];
      if (config.lightwalletd) args.push("--server", config.lightwalletd);
      const p = spawn(config.zingoBin, args, { stdio: ["pipe", "pipe", "pipe"] });
      this.p = p;
      p.stdout!.on("data", (d) => (this.out += d));
      p.stderr!.on("data", (d) => (this.err += d));
      p.on("close", (code) => { console.error(`[zingo:${this.name}] exited ${code}: ${this.err.slice(-300)}`); this.p = null; });
      // wait for the session to be usable (mixnet bootstrap); first command blocks until ready
      const r = await this.raw("height", 180_000);
      if (!/"height"/.test(r)) throw new Error(`[zingo:${this.name}] failed to start: ${this.err.slice(-400)}`);
      console.log(`[zingo:${this.name}] session ready`);
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async raw(cmd: string, timeoutMs = 120_000): Promise<string> {
    const p = this.p;
    if (!p || p.exitCode !== null) throw new Error(`zingo ${this.name} session not running`);
    const mark = `zkmark_${++this.n}`;
    this.out = ""; this.err = "";
    p.stdin!.write(cmd + "\n" + mark + "\n");
    const t0 = Date.now();
    while (!this.err.includes(`'${mark}'`)) {
      if (p.exitCode !== null) throw new Error(`zingo ${this.name} exited: ${this.err.slice(-300)}`);
      if (Date.now() - t0 > timeoutMs) throw new Error(`zingo ${this.name}: '${cmd}' timed out`);
      await sleep(50);
    }
    await sleep(30);
    const errText = this.err.split(`error: unrecognized subcommand '${mark}'`)[0].replace(/Launching (sync|save) task\.\.\.\n?/g, "").trim();
    if (errText && !this.out.trim()) throw new Error(`zingo ${this.name} '${cmd.split(" ")[0]}': ${errText.slice(-400)}`);
    return this.out;
  }

  cmd(cmd: string, timeoutMs?: number): Promise<string> {
    const run = async () => { await this.start(); return this.raw(cmd, timeoutMs); };
    const r = this.queue.then(run, run);
    this.queue = r.catch(() => {});
    return r;
  }
  async json(cmd: string, timeoutMs?: number) {
    const s = await this.cmd(cmd, timeoutMs);
    const i = s.search(/[{[]/);
    try { return JSON.parse(s.slice(i)); } catch { throw new Error(`zingo ${this.name} '${cmd}': non-JSON output: ${s.slice(0, 300)}`); }
  }
}

export class ZingoWallet implements ZcashWallet {
  private s: ZingoSession;
  private addr: string | null = null;
  constructor(public readonly name: string, dir: string) { this.s = new ZingoSession(name, dir); }

  async sync() { await this.s.cmd("sync run").catch(() => {}); }
  async height() { return Number((await this.s.json("height")).height); }
  async address() {
    if (this.addr) return this.addr;
    const a = await this.s.json("addresses");
    this.addr = a[0].encoded_address as string;
    return this.addr;
  }
  async freshAddress() {
    const out = await this.s.cmd("new_address o");
    const m = out.match(/\b(utest1|u1)[0-9a-z]+/);
    return m ? m[0] : this.address();
  }
  async balance() {
    const toZats = (v: unknown) => Number(String(v ?? 0).replace(/[_,\s]/g, "")) || 0; // zingo may print 1_000_000
    const spendable = toZats((await this.s.json("spendable_balance")).spendable_balance);
    const text = await this.s.cmd("balance");
    const total = [...text.matchAll(/total_\w+_balance:\s*([\d_,]+)/g)].reduce((a, m) => a + toZats(m[1]), 0);
    return { spendableZats: spendable, totalZats: total };
  }
  async send(to: string, zats: number, memo: string) {
    if (/["\n]/.test(memo)) throw new Error("memo must not contain quotes/newlines");
    await this.s.cmd(`send ${to} ${zats} "${memo}"`, 300_000); // proposal (shows fee)
    const r = await this.s.json("confirm", 600_000); // build proof + transmit (over mixnet)
    const txid = (r.txids ?? [])[0];
    if (!txid) throw new Error(`send failed: ${JSON.stringify(r).slice(0, 300)}`);
    return { txid: String(txid) };
  }
  async incomingSince(h: number): Promise<IncomingNote[]> {
    const r = await this.s.json("messages");
    return (r.value_transfers ?? [])
      .filter((v: any) => v.kind === "received")
      .map((v: any) => ({
        txid: String(v.txid),
        zats: Number(v.value),
        memo: (v.memos ?? []).join(""),
        height: /^confirmed/i.test(String(v.status)) ? Number(v.blockheight) : 0,
      }))
      .filter((n: IncomingNote) => n.height === 0 || n.height > h);
  }
}
