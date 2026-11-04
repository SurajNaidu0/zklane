import express from "express";
import path from "node:path";
import { config, ROOT } from "./config.js";
import { q } from "./db.js";
import { emit, sseHandler } from "./events.js";
import { Orchestrator, HttpError } from "./orchestrator.js";
import { makeWallets } from "./zcash/index.js";

const { customer, merchant } = await makeWallets();
const orch = new Orchestrator(customer, merchant);
await orch.init();

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, "web")));

const h = (fn: (req: express.Request) => Promise<unknown> | unknown) =>
  async (req: express.Request, res: express.Response) => {
    try { res.json(await fn(req)); }
    catch (e) {
      const err = e as HttpError;
      const status = err.status ?? 500;
      if (status >= 500) console.error(err);
      res.status(status).json({ error: err.message, detail: err.detail });
    }
  };

app.get("/events", sseHandler);

app.get("/api/status", h(async () => ({
  mode: config.zcashMode,
  height: orch.height,
  unit_zats: config.unitZats,
  open_zats: config.openZats,
  explorer: config.explorerTxUrl,
  merchant_address: await merchant.address().catch(() => null),
})));

app.get("/api/wallets", h(async () => {
  const [c, m] = await Promise.all([customer.balance().catch(() => null), merchant.balance().catch(() => null)]);
  return { customer: c, merchant: m };
}));

app.get("/api/channels", h(() => q.list.all()));
app.get("/api/channels/:name", h((req) => orch.get(String(req.params.name))));

// open: run zkChannels open+init, returns real channel id + funding memo
app.post("/api/channels", h((req) => orch.createChannel(req.body?.amount_zats)));
// customer wallet sends the real shielded funding tx
app.post("/api/channels/:name/fund", h((req) => orch.fund(String(req.params.name))));
// one off-chain ZK payment
app.post("/api/channels/:name/pay", h((req) => orch.pay(String(req.params.name), Number(req.body?.amount ?? 10), String(req.body?.item ?? "item"))));
app.post("/api/channels/:name/close", h((req) => orch.close(String(req.params.name))));
app.get("/api/channels/:name/balance", h((req) => orch.peekBalance(String(req.params.name)).then((u) => ({ cust_units: u }))));
// cheat demo
app.post("/api/channels/:name/snapshot", h((req) => orch.snapshot(String(req.params.name))));
app.post("/api/channels/:name/cheat-close", h((req) => orch.cheatClose(String(req.params.name))));

// merchant view: what the merchant actually knows
app.get("/api/merchant/payments", h(() => ({ payments: q.payments.all(), stats: q.stats.get() })));

// manual watcher kick (useful in demos)
app.post("/api/watch", h(async () => { await orch.tick(); return { ok: true }; }));

app.listen(config.port, () => {
  console.log(`zkLane on http://localhost:${config.port}  (ZCASH_MODE=${config.zcashMode})`);
  emit("server.ready", { mode: config.zcashMode });
});

for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => { orch.zk.shutdown(); process.exit(0); });
