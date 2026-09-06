import { beforeEach, describe, expect, it, vi } from "vitest";
import EventEmitter from "eventemitter3";
import { MockMessage } from "@Packages/message/mock_message";
import { Server } from "@Packages/message/server";
import { initTestEnv } from "@Tests/initTestEnv";
import {
  CONTINUATION_SHIM_URL,
  ContinuationShimConnect,
  type ContinuationShimRelay,
} from "./continuation-shim-connect";

initTestEnv();

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  receive(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

let sockets: MockWebSocket[] = [];

function makeHarness() {
  const server = new Server("offscreen", new MockMessage(new EventEmitter<string, unknown>()));
  const relay: ContinuationShimRelay = {
    message: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue(undefined),
  };
  const connect = new ContinuationShimConnect(server.group("continuationShimConnect"), relay);
  connect.init();
  return { connect, relay };
}

beforeEach(() => {
  sockets = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
});

describe("ContinuationShimConnect", () => {
  it("opens exactly one extension-owned socket at the fixed local shim URL", async () => {
    const { connect, relay } = makeHarness();
    await connect.ensure();
    await connect.ensure();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe(CONTINUATION_SHIM_URL);
    expect(relay.status).toHaveBeenCalledWith("CONNECTING");
    sockets[0].open();
    expect(relay.status).toHaveBeenLastCalledWith("CONNECTED");
  });

  it("queues semantic messages while connecting and flushes them in order on open", async () => {
    const { connect } = makeHarness();
    const first = { type: "SESSION_UPSERT", revision: 1 };
    const second = { type: "SESSION_HEARTBEAT", sessionId: "s1" };
    await connect.send(first);
    await connect.send(second);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].sent).toEqual([]);
    sockets[0].open();
    expect(sockets[0].sent.map((item) => JSON.parse(item))).toEqual([first, second]);
  });

  it("relays parsed shim messages to the service worker", async () => {
    const { connect, relay } = makeHarness();
    await connect.ensure();
    sockets[0].open();
    const incoming = { type: "HOST_HELLO", hostInstanceId: "host-a" };
    sockets[0].receive(incoming);
    await Promise.resolve();
    expect(relay.message).toHaveBeenCalledWith(incoming);
  });
});
