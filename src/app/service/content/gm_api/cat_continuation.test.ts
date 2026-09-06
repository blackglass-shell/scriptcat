import EventEmitter from "eventemitter3";
import { describe, expect, it, vi } from "vitest";
import { GMContextApiGet } from "./gm_context";
import CATContinuationApi from "./cat_continuation";
import type { ContinuationShimMessage } from "../../service_worker/continuation_shim";

void CATContinuationApi;

function getApi(fnKey: string) {
  const api = GMContextApiGet("CAT.continuation")?.find((entry) => entry.fnKey === fnKey);
  if (!api) throw new Error(`missing CAT.continuation API: ${fnKey}`);
  return api.api as (...args: any[]) => any;
}

function makeContext() {
  return {
    sendMessage: vi.fn().mockResolvedValue({
      tabId: 17,
      frameId: 0,
      documentId: "doc-17",
      windowId: 4,
      status: "CONNECTED",
    }),
    EE: new EventEmitter(),
  };
}

describe("CAT.continuation content API", () => {
  it("registers the complete narrow surface under one grant", () => {
    const keys = (GMContextApiGet("CAT.continuation") || []).map((entry) => entry.fnKey).sort();
    expect(keys).toEqual([
      "CAT.continuation.addListener",
      "CAT.continuation.connect",
      "CAT.continuation.disconnect",
      "CAT.continuation.removeListener",
      "CAT.continuation.send",
      "CAT.continuation.status",
    ]);
  });

  it("maps connect/status/send/disconnect to CAT_continuation requests", async () => {
    const ctx = makeContext();
    const message: ContinuationShimMessage = { type: "SESSION_HEARTBEAT", sessionId: "s1" };

    await getApi("CAT.continuation.connect").call(ctx);
    await getApi("CAT.continuation.status").call(ctx);
    await getApi("CAT.continuation.send").call(ctx, message);
    await getApi("CAT.continuation.disconnect").call(ctx);

    expect(ctx.sendMessage.mock.calls).toEqual([
      ["CAT_continuation", [{ action: "connect" }]],
      ["CAT_continuation", [{ action: "status" }]],
      ["CAT_continuation", [{ action: "send", message }]],
      ["CAT_continuation", [{ action: "disconnect" }]],
    ]);
  });

  it("delivers and removes continuationShim:message listeners on the script EventEmitter", () => {
    const ctx = makeContext();
    const callback = vi.fn();
    const add = getApi("CAT.continuation.addListener");
    const remove = getApi("CAT.continuation.removeListener");
    const listenerId = add.call(ctx, callback) as number;
    const message: ContinuationShimMessage = { type: "HOST_HELLO", hostInstanceId: "host-1" };

    ctx.EE.emit("continuationShim:message", message);
    expect(callback).toHaveBeenCalledWith(message);

    remove.call(ctx, listenerId);
    ctx.EE.emit("continuationShim:message", { type: "SESSION_REMOVE", sessionId: "s1" });
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
