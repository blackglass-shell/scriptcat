import { describe, expect, it, vi } from "vitest";
import EventEmitter from "eventemitter3";
import { MockMessage } from "@Packages/message/mock_message";
import { Server, type IGetSender } from "@Packages/message/server";
import type { ExtMessageSender } from "@Packages/message/types";
import { initTestEnv } from "@Tests/initTestEnv";
import {
  ContinuationShimService,
  type ContinuationShimConnectPort,
  type ContinuationShimMessage,
} from "./continuation_shim";

initTestEnv();

function makeSender(tabId: number, documentId = `doc-${tabId}`): IGetSender {
  const ext: ExtMessageSender = { tabId, frameId: 0, documentId, windowId: 7 };
  return {
    getType: () => 0,
    isType: () => false,
    getSender: () => undefined,
    getExtMessageSender: () => ext,
    getConnect: () => undefined,
  };
}

function makeHarness() {
  const server = new Server("serviceWorker", new MockMessage(new EventEmitter<string, unknown>()));
  const connector: ContinuationShimConnectPort = {
    ensure: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue("CONNECTED"),
  };
  const emitEvent = vi.fn().mockResolvedValue(undefined);
  const service = new ContinuationShimService(server.group("continuationShim"), connector, emitEvent);
  service.init();
  return { service, connector, emitEvent };
}

describe("ContinuationShimService", () => {
  it("subscribes with real browser tab identity and ensures one extension-owned socket", async () => {
    const { service, connector } = makeHarness();
    const result = await service.handleApi("script-1", { action: "connect" }, makeSender(42, "doc-a"));
    expect(result).toMatchObject({ tabId: 42, frameId: 0, documentId: "doc-a", windowId: 7, status: "CONNECTED" });
    expect(connector.ensure).toHaveBeenCalledTimes(1);
    expect(service.subscriberCount()).toBe(1);
  });

  it("forwards only browser protocol messages and refreshes the sender subscription on send", async () => {
    const { service, connector } = makeHarness();
    const message: ContinuationShimMessage = { type: "SESSION_HEARTBEAT", sessionId: "s1" };
    await service.handleApi("script-1", { action: "send", message }, makeSender(9));
    expect(connector.ensure).toHaveBeenCalledTimes(1);
    expect(connector.send).toHaveBeenCalledWith(message);
    expect(service.subscriberCount()).toBe(1);

    await expect(
      service.handleApi("script-1", { action: "send", message: { type: "HOST_HELLO" } }, makeSender(9))
    ).rejects.toThrow("unsupported continuation shim outbound message type");
  });

  it("fans incoming shim messages into ScriptCat's existing runtime event channel", async () => {
    const { service, emitEvent } = makeHarness();
    await service.handleApi("script-1", { action: "connect" }, makeSender(3, "doc-3"));
    await service.handleRelayMessage({ type: "SESSION_UPSERT", session: { sessionId: "remote" } });
    expect(emitEvent).toHaveBeenCalledWith(
      { tabId: 3, frameId: 0, documentId: "doc-3", windowId: 7 },
      expect.objectContaining({ uuid: "script-1", event: "continuationShim", eventId: "message" })
    );
  });

  it("replays the current bootstrap state to a tab that joins an already-connected socket", async () => {
    const { service, emitEvent } = makeHarness();
    const address = {
      hostInstanceId: "host-1",
      browserInstanceId: "browser-1",
      tabInstanceId: "tab-1",
      sessionId: "session-1",
    };
    await service.handleApi("script-1", { action: "connect" }, makeSender(1, "doc-1"));
    await service.handleRelayMessage({ type: "HOST_HELLO", host: { hostInstanceId: "host-1" } });
    await service.handleRelayMessage({
      type: "SESSION_SNAPSHOT",
      sessions: [{ address, revision: 1, heartbeatAt: 10 }],
    });
    await service.handleRelayMessage({
      type: "SESSION_UPSERT",
      session: { address, revision: 2, heartbeatAt: 20, state: "READY" },
    });
    emitEvent.mockClear();

    await service.handleApi("script-1", { action: "connect" }, makeSender(2, "doc-2"));

    const tab2Messages = emitEvent.mock.calls.filter(([to]) => to.tabId === 2).map(([, request]) => request.data);
    expect(tab2Messages[0]).toMatchObject({ type: "HOST_HELLO", host: { hostInstanceId: "host-1" } });
    expect(tab2Messages[1]).toMatchObject({
      type: "SESSION_SNAPSHOT",
      sessions: [expect.objectContaining({ address, revision: 2, heartbeatAt: 20, state: "READY" })],
    });
  });

  it("removes subscriptions when Chrome reports the physical tab closed", async () => {
    const { service, connector } = makeHarness();
    await service.handleApi("script-1", { action: "connect" }, makeSender(77));
    expect(service.subscriberCount()).toBe(1);

    await chrome.tabs.remove(77);
    await Promise.resolve();

    expect(service.subscriberCount()).toBe(0);
    expect(connector.disconnect).toHaveBeenCalledTimes(1);
  });

  it("disconnect removes only the calling script/tab subscription", async () => {
    const { service, connector } = makeHarness();
    await service.handleApi("script-1", { action: "connect" }, makeSender(1));
    await service.handleApi("script-1", { action: "connect" }, makeSender(2));
    await service.handleApi("script-1", { action: "disconnect" }, makeSender(1));
    expect(service.subscriberCount()).toBe(1);
    expect(connector.disconnect).not.toHaveBeenCalled();
  });
});
