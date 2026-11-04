// Drives the real libzkchannels ZK-mode CLI (SPEC-v1 §2–§4).
// Customer and merchant are separate OS processes talking over TCP; each party has
// its own Redis DB. All protocol steps are serialized through one queue.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";

const execFileP = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const merchUrl = () => `redis://127.0.0.1:${config.redisPort}/${config.merchDb}`;
const custUrl = () => `redis://127.0.0.1:${config.redisPort}/${config.custDb}`;
const M = () => ["--party", "MERCH", "--own-port", String(config.merchPort), "--other-port", String(config.custPort)];
const C = () => ["--party", "CUST", "--own-port", String(config.custPort), "--other-port", String(config.merchPort)];

export interface RunResult { code: number | null; out: string; ms: number }

export class ZkCli {
  workDir = path.join(config.dataDir, "zk");
  private queue: Promise<unknown> = Promise.resolve();
  private payDaemon: ChildProcess | null = null;
  private payDaemonOut = "";

  constructor() { fs.mkdirSync(this.workDir, { recursive: true }); }

  /** serialize every protocol step (ports + Redis state are shared) */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  private run(args: string[], dbUrl: string, timeoutMs = 60_000): Promise<RunResult> {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const p = spawn(config.zkBin, args, { cwd: this.workDir, env: { ...process.env, ZKLANE_DB_URL: dbUrl, RUST_BACKTRACE: "0" } });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
      p.on("close", (code) => { clearTimeout(timer); resolve({ code, out, ms: Math.round(performance.now() - t0) }); });
    });
  }

  /** one two-party step: merchant listens first, then the customer connects */
  private async twoParty(cmd: string, custArgs: string[], merchExtra: string[] = []) {
    const merch = spawn(config.zkBin, [cmd, ...M(), ...merchExtra], { cwd: this.workDir, env: { ...process.env, ZKLANE_DB_URL: merchUrl() } });
    let mout = "";
    merch.stdout.on("data", (d) => (mout += d));
    merch.stderr.on("data", (d) => (mout += d));
    const merchDone = new Promise<number | null>((r) => merch.on("close", r));
    await sleep(300);
    const cust = await this.run([cmd, ...C(), ...custArgs], custUrl());
    // merchant normally exits on its own; give it a moment, then kill
    await Promise.race([merchDone, sleep(1500)]);
    if (merch.exitCode === null) merch.kill("SIGKILL");
    return { cust, merchOut: mout };
  }

  private checkFail(step: string, r: { cust: RunResult; merchOut: string }) {
    const bad = /failed with error|panicked|FAILED|rejected/i;
    if (r.cust.code !== 0 || bad.test(r.cust.out) || bad.test(r.merchOut)) {
      const clean = (s: string) => s.replace(/\*{10,}/g, "").trim().split("\n").slice(-6).join("\n");
      throw new Error(`${step} failed:\nCUST: ${clean(r.cust.out)}\nMERCH: ${clean(r.merchOut)}`);
    }
  }

  async setup() {
    // tx fee info is read by each party from its own DB
    await this.run(["setfees"], merchUrl());
    await this.run(["setfees"], custUrl());
  }

  /** open + init. Returns the real zkChannels channel id (hex, no 0x). */
  openInit(name: string, custUnits: number, merchUnits: number) {
    return this.exclusive(async () => {
      await this.stopPayDaemonLocked();
      const o = await this.twoParty("open", ["-n", name, "-c", String(custUnits), "-m", String(merchUnits)]);
      this.checkFail("open", o);
      const total = custUnits + merchUnits;
      const i = await this.twoParty("init", ["-n", name, "-a", String(total + 10), "-o", String(total)]);
      this.checkFail("init", i);
      const m = i.cust.out.match(/Channel id: 0x([0-9a-f]{64})/);
      if (!m) throw new Error("init: could not parse channel id\n" + i.cust.out.slice(-500));
      return { channelId: m[1], ms: o.cust.ms + i.cust.ms };
    });
  }

  /** activate (merchant marks open with the REAL escrow txid) + unlink */
  activateUnlink(name: string, escrowTxid: string) {
    return this.exclusive(async () => {
      await this.stopPayDaemonLocked();
      const a = await this.twoParty("activate", ["-n", name], ["--escrow-txid", escrowTxid]);
      this.checkFail("activate", a);
      const u = await this.twoParty("unlink", ["-n", name]);
      this.checkFail("unlink", u);
      return { merchOut: a.merchOut };
    });
  }

  /** long-lived merchant pay server (cli_zk.rs runs merch::pay in a loop) */
  private async ensurePayDaemonLocked() {
    if (this.payDaemon && this.payDaemon.exitCode === null) return;
    this.payDaemonOut = "";
    this.payDaemon = spawn(config.zkBin, ["pay", ...M()], { cwd: this.workDir, env: { ...process.env, ZKLANE_DB_URL: merchUrl() } });
    this.payDaemon.stdout!.on("data", (d) => (this.payDaemonOut += d));
    this.payDaemon.stderr!.on("data", (d) => (this.payDaemonOut += d));
    await sleep(300);
  }
  private async stopPayDaemonLocked() {
    const d = this.payDaemon;
    if (!d || d.exitCode !== null) return;
    const done = new Promise((r) => d.on("close", r));
    d.kill("SIGKILL");
    await done;
    this.payDaemon = null;
  }

  /** one real ZK payment. Returns latency and whether the merchant accepted. */
  pay(name: string, units: number) {
    return this.exclusive(async () => {
      await this.ensurePayDaemonLocked();
      const before = (this.payDaemonOut.match(/valid pay tokend? delivered: true/g) || []).length;
      const r = await this.run(["pay", ...C(), "-n", name, "-a", String(units)], custUrl(), 30_000);
      await sleep(20);
      const after = (this.payDaemonOut.match(/valid pay tokend? delivered: true/g) || []).length;
      const ok = r.code === 0 && after > before && !/failed|rejected/i.test(r.out);
      return { ok, ms: r.ms, out: ok ? "" : r.out.slice(-600) + "\nMERCH: " + this.payDaemonOut.slice(-400) };
    });
  }

  /** customer builds its close message from its CURRENT local state */
  custClose(name: string, tag = "close") {
    return this.exclusive(async () => {
      await this.stopPayDaemonLocked();
      const file = `${name}_${tag}.json`;
      const r = await this.run(["close", "--party", "CUST", "-n", name, "--file", file], custUrl());
      const cliFile = path.join(this.workDir, `cli_${file}`);
      if (r.code !== 0 || !fs.existsSync(cliFile)) throw new Error("customer close failed: " + r.out.slice(-500));
      const msg = JSON.parse(fs.readFileSync(cliFile, "utf8"));
      return { file: cliFile, custBal: Number(msg.message.bc), merchBal: Number(msg.message.bm) };
    });
  }

  /**
   * merchant checks the customer's close message.
   * libzkchannels: if the close is on a REVOKED state, merchant finds the rev_lock in its
   * state and outputs {rev_lock, rev_secret} = proof of cheating. Otherwise "Valid close!".
   */
  merchClose(channelId: string, custCloseFile: string) {
    return this.exclusive(async () => {
      await this.stopPayDaemonLocked();
      const out = path.join(this.workDir, `merch_close_${channelId.slice(0, 12)}_${Date.now()}.json`);
      const r = await this.run(["close", "--party", "MERCH", "--cust-close", custCloseFile, "--file", out, "-n", channelId], merchUrl());
      if (fs.existsSync(out)) {
        const ev = JSON.parse(fs.readFileSync(out, "utf8"));
        return { verdict: "revoked" as const, evidence: ev as { rev_lock: string; rev_secret: string } };
      }
      if (/Valid close!/.test(r.out)) return { verdict: "valid" as const };
      if (/not valid/.test(r.out)) return { verdict: "invalid" as const, detail: r.out.slice(-300) };
      throw new Error("merchant close: unexpected output " + r.out.slice(-400));
    });
  }

  // --- cheat demo helpers: snapshot / restore customer's local wallet state in Redis ---
  private async redis(...args: string[]) {
    const { stdout } = await execFileP("redis-cli", ["-p", String(config.redisPort), "-n", String(config.custDb), ...args], { maxBuffer: 1 << 24 });
    return stdout.replace(/\n$/, "");
  }
  /** copy the customer's current local state into a labelled slot */
  snapshotCustState(name: string, slot = "old") {
    return this.exclusive(async () => {
      const v = await this.redis("hget", `id:${name}`, `cust:${name}:cust_state`);
      if (!v || v.length < 100) throw new Error("no customer state to snapshot");
      await this.redis("hset", `zklane:backup:${name}`, slot, v);
      return v.length;
    });
  }
  /** overwrite the customer's current local state from a labelled slot */
  restoreCustState(name: string, slot = "old") {
    return this.exclusive(async () => {
      const v = await this.redis("hget", `zklane:backup:${name}`, slot);
      if (!v || v.length < 100) throw new Error(`no snapshot '${slot}' for ${name}`);
      await this.redis("hset", `id:${name}`, `cust:${name}:cust_state`, v);
    });
  }

  shutdown() { this.payDaemon?.kill("SIGKILL"); }
}
