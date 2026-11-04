// SPEC.md §6 — Zcash wallet adapter interface (identical for real and mock).
export interface IncomingNote {
  txid: string;
  zats: number;
  memo: string;
  height: number;
}

export interface ZcashWallet {
  readonly name: string;
  sync(): Promise<void>;
  height(): Promise<number>;
  address(): Promise<string>; // unified (shielded) address
  freshAddress(): Promise<string>; // new diversified/shielded address (refund target)
  balance(): Promise<{ spendableZats: number; totalZats: number }>;
  send(to: string, zats: number, memo: string): Promise<{ txid: string }>;
  incomingSince(height: number): Promise<IncomingNote[]>;
}

export const memo = (kind: "open" | "close", channelId: string, extra?: string) =>
  `zklane:v1:${kind}:${channelId}${extra ? ":" + extra : ""}`;
