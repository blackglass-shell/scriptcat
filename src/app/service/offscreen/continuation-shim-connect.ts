import LoggerCore from "@App/app/logger/core";
import Logger from "@App/app/logger/logger";
import type { Group } from "@Packages/message/server";
import type { ContinuationShimMessage, ContinuationShimStatus } from "../service_worker/continuation_shim";

export const CONTINUATION_SHIM_URL = "ws://127.0.0.1:17831/ws/browser";

const CONFIG = {
  BASE_RECONNECT_DELAY_MS: 1000,
  MAX_RECONNECT_DELAY_MS: 30_000,
  MAX_QUEUED_MESSAGES: 256,
} as const;

export interface ContinuationShimRelay {
  message(message: ContinuationShimMessage): Promise<void>;
  status(status: ContinuationShimStatus): Promise<void>;
}

export class ContinuationShimConnect {
  private readonly logger = LoggerCore.logger().with({ service: "ContinuationShimConnect" });
  private ws: WebSocket | null = null;
  private desired = false;
  private epoch = 0;
  private statusValue: ContinuationShimStatus = "DISCONNECTED";
  private reconnectDelayMs: number = CONFIG.BASE_RECONNECT_DELAY_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly queued: ContinuationShimMessage[] = [];

  constructor(
    private readonly group: Group,
    private readonly relay: ContinuationShimRelay
  ) {}

  init(): void {
    this.group.on("ensure", () => this.ensure());
    this.group.on("disconnect", () => this.disconnect());
    this.group.on("send", (message: ContinuationShimMessage) => this.send(message));
    this.group.on("status", () => this.status());
  }

  status(): ContinuationShimStatus {
    return this.statusValue;
  }

  async ensure(): Promise<void> {
    this.desired = true;
    if (this.ws || this.reconnectTimer) return;
    this.connect(++this.epoch);
  }

  async send(message: ContinuationShimMessage): Promise<void> {
    await this.ensure();
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return;
    }

    if (this.queued.length >= CONFIG.MAX_QUEUED_MESSAGES) {
      throw new Error("continuation shim outbound queue full");
    }
    this.queued.push(message);
  }

  async disconnect(): Promise<void> {
    this.desired = false;
    this.epoch++;
    this.clearReconnectTimer();
    this.queued.length = 0;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.close();
    }
    this.reconnectDelayMs = CONFIG.BASE_RECONNECT_DELAY_MS;
    await this.setStatus("DISCONNECTED");
  }

  private connect(epoch: number): void {
    if (!this.desired || this.ws) return;
    void this.setStatus("CONNECTING");
    try {
      const ws = new WebSocket(CONTINUATION_SHIM_URL);
      this.ws = ws;
      ws.onopen = () => this.handleOpen(ws, epoch);
      ws.onmessage = (event) => void this.handleMessage(event, epoch);
      ws.onclose = () => this.handleClose(ws, epoch);
      ws.onerror = (event) => this.handleError(ws, event, epoch);
    } catch (error) {
      this.logger.error("continuation shim WebSocket creation failed", Logger.E(error));
      this.ws = null;
      void this.setStatus("DISCONNECTED");
      this.scheduleReconnect(epoch);
    }
  }

  private handleOpen(ws: WebSocket, epoch: number): void {
    if (epoch !== this.epoch || ws !== this.ws) return;
    this.reconnectDelayMs = CONFIG.BASE_RECONNECT_DELAY_MS;
    void this.setStatus("CONNECTED");
    const queued = this.queued.splice(0);
    for (const message of queued) {
      ws.send(JSON.stringify(message));
    }
  }

  private async handleMessage(event: MessageEvent, epoch: number): Promise<void> {
    if (epoch !== this.epoch) return;
    try {
      const parsed = JSON.parse(String(event.data)) as unknown;
      if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") {
        throw new Error("continuation shim message missing type");
      }
      await this.relay.message(parsed as ContinuationShimMessage);
    } catch (error) {
      this.logger.error("continuation shim message decode failed", Logger.E(error));
    }
  }

  private handleClose(ws: WebSocket, epoch: number): void {
    if (epoch !== this.epoch || ws !== this.ws) return;
    this.ws = null;
    void this.setStatus("DISCONNECTED");
    this.scheduleReconnect(epoch);
  }

  private handleError(ws: WebSocket, event: Event, epoch: number): void {
    if (epoch !== this.epoch || ws !== this.ws) return;
    this.logger.error("continuation shim WebSocket error", { event: event.type });
    if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
      ws.close();
    }
  }

  private scheduleReconnect(epoch: number): void {
    if (!this.desired || epoch !== this.epoch || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectTimer = setTimeout(() => {
      if (epoch !== this.epoch || !this.desired) return;
      this.reconnectTimer = null;
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, CONFIG.MAX_RECONNECT_DELAY_MS);
      this.connect(epoch);
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private async setStatus(status: ContinuationShimStatus): Promise<void> {
    if (this.statusValue === status) return;
    this.statusValue = status;
    try {
      await this.relay.status(status);
    } catch (error) {
      this.logger.error("continuation shim status relay failed", Logger.E(error));
    }
  }
}
