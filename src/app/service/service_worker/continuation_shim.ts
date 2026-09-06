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

export class ContinuationShimService {
  private readonly subscribers = new Map<string, Subscriber>();
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

  async handleRelayMessage(message: ContinuationShimMessage): Promise<void> {
    if (!message || typeof message !== "object" || typeof message.type !== "string") return;
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
