import type { Response } from "express";

const clients = new Set<Response>();
const recent: string[] = [];

export function sseHandler(_req: unknown, res: Response) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(": hi\n\n");
  clients.add(res);
  res.on("close", () => clients.delete(res));
}

export function emit(type: string, data: Record<string, unknown> = {}) {
  const line = `event: ${type}\ndata: ${JSON.stringify({ ...data, t: Date.now() })}\n\n`;
  recent.push(line);
  if (recent.length > 50) recent.shift();
  for (const c of clients) c.write(line);
  console.log(`[event] ${type}`, JSON.stringify(data).slice(0, 160));
}

setInterval(() => { for (const c of clients) c.write(": ping\n\n"); }, 20_000).unref();
