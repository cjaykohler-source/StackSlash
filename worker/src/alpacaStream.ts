import WebSocket from "ws";
import { config } from "./config.js";

export interface Trade {
  symbol: string;
  price: number;
  timestamp: string;
}

type TradeHandler = (trade: Trade) => void;

/**
 * Alpaca market data websocket client with auth, subscription, and
 * exponential-backoff reconnect. This is the piece that makes this a
 * genuine stream instead of the poll-based intraday-scan.ts — one
 * persistent connection, trades pushed to us the instant they print,
 * rather than us asking "what's the price now?" on a timer.
 *
 * Protocol: https://docs.alpaca.markets/docs/streaming-market-data
 * Connect -> receive "connected" -> send auth -> receive "authenticated"
 * -> send subscribe -> receive trade messages (type "t") continuously.
 */
export class AlpacaTradeStream {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private closedByUs = false;
  private readonly symbols: string[];
  private readonly onTrade: TradeHandler;
  private readonly onStatus: (msg: string) => void;

  constructor(symbols: string[], onTrade: TradeHandler, onStatus: (msg: string) => void) {
    this.symbols = symbols;
    this.onTrade = onTrade;
    this.onStatus = onStatus;
  }

  start() {
    this.closedByUs = false;
    this.connect();
  }

  stop() {
    this.closedByUs = true;
    this.ws?.close();
  }

  private connect() {
    this.onStatus(`connecting to ${config.alpacaStreamUrl}`);
    const ws = new WebSocket(config.alpacaStreamUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.onStatus("socket open, authenticating");
      ws.send(
        JSON.stringify({
          action: "auth",
          key: config.alpacaKeyId,
          secret: config.alpacaSecretKey,
        }),
      );
    });

    ws.on("message", (raw) => {
      let messages: unknown;
      try {
        messages = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!Array.isArray(messages)) return;

      for (const msg of messages) {
        this.handleMessage(msg as Record<string, unknown>);
      }
    });

    ws.on("close", (code) => {
      this.onStatus(`socket closed (code ${code})`);
      if (!this.closedByUs) this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      this.onStatus(`socket error: ${err instanceof Error ? err.message : String(err)}`);
      // "close" fires after "error" for ws, reconnect handled there.
    });
  }

  private handleMessage(msg: Record<string, unknown>) {
    const type = msg.T;

    if (type === "success" && msg.msg === "authenticated") {
      this.onStatus("authenticated, subscribing");
      this.reconnectAttempt = 0;
      this.ws?.send(JSON.stringify({ action: "subscribe", trades: this.symbols }));
      return;
    }

    if (type === "error") {
      this.onStatus(`stream error: ${JSON.stringify(msg)}`);
      return;
    }

    if (type === "t") {
      const symbol = msg.S as string | undefined;
      const price = msg.p as number | undefined;
      const timestamp = msg.t as string | undefined;
      if (symbol && typeof price === "number" && timestamp) {
        this.onTrade({ symbol, price, timestamp });
      }
    }
  }

  private scheduleReconnect() {
    this.reconnectAttempt += 1;
    const delayMs = Math.min(30_000, 1000 * 2 ** this.reconnectAttempt);
    this.onStatus(`reconnecting in ${delayMs}ms (attempt ${this.reconnectAttempt})`);
    setTimeout(() => {
      if (!this.closedByUs) this.connect();
    }, delayMs);
  }
}
