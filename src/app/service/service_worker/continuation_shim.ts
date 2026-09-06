import type { Group, IGetSender } from "@Packages/message/server";
import type { ExtMessageSender } from "@Packages/message/types";
import type { EmitEventRequest } from "./types";

export type ContinuationShimStatus = "DISCONNECTED" | "CONNECTING" | "CONNECTED";

export type ContinuationShimMessage = {
  type: string;
  [key: string]: unknown;
};

export type ContinuationShimApiRequest =
  | { action: "connect" }
  | { action: "disconnect" }
  | { action: "status" }
  | { action: "send"; message: ContinuationShimMessage };

export type ContinuationShimSubscriptionInfo = ExtMessageSender & {
  status: ContinuationShimStatus;
};

export interface ContinuationShimConnectPort {
  ensure(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: ContinuationShimMessage): Promise<void>;
  status(): Promise<ContinuationShimStatus>;
}

const OUTBOUND_TYPES = new Set(["SESSION_UPSERT", "SESSION_HEARTBEAT", "SESSION_REMOVE"]);

type Subscriber = {
  uuid: string;
  sender: ExtMessageSender;
};

type EmitToTab = (to: ExtMessageSender, req: EmitEventRequest) => void | Promise<unknown>;

function senderKey(uuid: string, sender: ExtMessageSender): string {
  return `${uuid}:${sender.tabId}:${sender.frameId ?? 0}`;
}

function assertOutboundMessage(message: ContinuationShimMessage): void {
  if (!message || typeof message !== "object" || !OUTBOUND_TYPES.has(message.type)) {
    throw new Error("unsupported continuation shim outbound message type");
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function sessionKey(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  const address = asRecord(record.address) ?? record;
  const parts = ["hostInstanceId", "browserInstanceId", "tabInstanceId", "sessionId"].map((key) => address[key]);
  if (parts.some((part) => typeof part !== "string" || part.length === 0)) return null;
  return parts.join("/");
}

function revisionOf(value: unknown): number {
  const revision = Number(asRecord(value)?.revision ?? 0);
  return Number.isFinite(revision) ? revision : 0;
}

export class ContinuationShimService {
  private readonly subscribers = new Map<string, Subscriber>();
  private readonly sessions = new Map<string, Record<string, unknown>>();
  private hostHello: ContinuationShimMessage | null = null;
  private snapshotSeen = false;
  private status: ContinuationShimStatus = "DISCONNECTED";

  constructor(
    private readonly group: Group,
    private readonly connector: ContinuationShimConnectPort,
    private readonly emitToTab: EmitToTab
  ) {}

  init(): void {
    this.group.on("message", (message: ContinuationShimMessage) => this.handleRelayMessage(message));
    this.group.on("status", (status: ContinuationShimStatus) => this.handleRelayStatus(status));
    chrome.tabs.onRemoved.addListener((tabId) => {
      void this.removeTab(tabId);
    });
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

  async handleApi(uuid: string, request: ContinuationShimApiRequest, sender: IGetSender): Promise<unknown> {
    const extSender = sender.getExtMessageSender();
    switch (request.action) {
      case "connect":
        await this.subscribe(uuid, extSender);
        await this.replayBootstrap(uuid, extSender);
        return { ...extSender, status: this.status } satisfies ContinuationShimSubscriptionInfo;
      case "disconnect":
        await this.unsubscribe(uuid, extSender);
        return undefined;
      case "status":
        this.status = await this.connector.status();
        return { ...extSender, status: this.status } satisfies ContinuationShimSubscriptionInfo;
      case "send":
        assertOutboundMessage(request.message);
        await this.subscribe(uuid, extSender);
        await this.connector.send(request.message);
        return undefined;
    }
  }

  private async subscribe(uuid: string, sender: ExtMessageSender): Promise<void> {
    this.subscribers.set(senderKey(uuid, sender), { uuid, sender: { ...sender } });
    await this.connector.ensure();
    this.status = await this.connector.status();
  }

  private async unsubscribe(uuid: string, sender: ExtMessageSender): Promise<void> {
    this.subscribers.delete(senderKey(uuid, sender));
    await this.disconnectWhenUnused();
  }

  private async removeTab(tabId: number): Promise<void> {
    for (const [key, subscriber] of this.subscribers) {
      if (subscriber.sender.tabId === tabId) this.subscribers.delete(key);
    }
    await this.disconnectWhenUnused();
  }

  private async disconnectWhenUnused(): Promise<void> {
    if (this.subscribers.size === 0) {
      await this.connector.disconnect();
    }
  }

  private updateBootstrapState(message: ContinuationShimMessage): void {
    if (message.type === "HOST_HELLO") {
      this.hostHello = message;
      return;
    }

    if (message.type === "SESSION_SNAPSHOT") {
      this.sessions.clear();
      for (const session of Array.isArray(message.sessions) ? message.sessions : []) {
        const record = asRecord(session);
        const key = sessionKey(record);
        if (record && key) this.sessions.set(key, record);
      }
      this.snapshotSeen = true;
      return;
    }

    if (message.type === "SESSION_UPSERT") {
      const record = asRecord(message.session);
      const key = sessionKey(record);
      if (!record || !key) return;
      const previous = this.sessions.get(key);
      if (!previous || revisionOf(record) >= revisionOf(previous)) this.sessions.set(key, record);
      return;
    }

    if (message.type === "SESSION_HEARTBEAT") {
      const key = sessionKey(message.address);
      const previous = key ? this.sessions.get(key) : undefined;
      if (!key || !previous) return;
      const heartbeatAt = Math.max(Number(previous.heartbeatAt ?? 0), Number(message.heartbeatAt ?? 0));
      this.sessions.set(key, { ...previous, heartbeatAt });
      return;
    }

    if (message.type === "SESSION_REMOVE") {
      const key = sessionKey(message.address);
      const previous = key ? this.sessions.get(key) : undefined;
      if (key && (!previous || revisionOf(message) >= revisionOf(previous))) this.sessions.delete(key);
    }
  }

  private async replayBootstrap(uuid: string, sender: ExtMessageSender): Promise<void> {
    if (!this.snapshotSeen) return;
    if (this.hostHello) {
      await this.emitToTab(sender, {
        uuid,
        event: "continuationShim",
        eventId: "message",
        data: this.hostHello,
      });
    }
    await this.emitToTab(sender, {
      uuid,
      event: "continuationShim",
      eventId: "message",
      data: { type: "SESSION_SNAPSHOT", sessions: [...this.sessions.values()] },
    });
  }

  async handleRelayMessage(message: ContinuationShimMessage): Promise<void> {
    if (!message || typeof message !== "object" || typeof message.type !== "string") return;
    this.updateBootstrapState(message);
    const subscribers = [...this.subscribers.entries()];
    const results = await Promise.allSettled(
      subscribers.map(([, subscriber]) =>
        this.emitToTab(subscriber.sender, {
          uuid: subscriber.uuid,
          event: "continuationShim",
          eventId: "message",
          data: message,
        })
      )
    );

    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "rejected") {
        this.subscribers.delete(subscribers[i][0]);
      }
    }
    await this.disconnectWhenUnused();
  }

  async handleRelayStatus(status: ContinuationShimStatus): Promise<void> {
    this.status = status;
    if (this.subscribers.size === 0) return;
    await this.handleRelayMessage({ type: "BRIDGE_STATUS", status });
  }
}
