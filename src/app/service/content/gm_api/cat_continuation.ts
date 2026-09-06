import type EventEmitter from "eventemitter3";
import GMContext from "./gm_context";
import type { ContinuationShimMessage, ContinuationShimSubscriptionInfo } from "../../service_worker/continuation_shim";

type ContinuationListener = (message: ContinuationShimMessage) => void;

let listenerCounter = 0;
const listeners = new Map<number, { emitter: EventEmitter; eventName: string; callback: ContinuationListener }>();

export default class CATContinuationApi {
  @GMContext.protected()
  protected sendMessage!: (api: string, params: unknown[]) => Promise<unknown>;

  @GMContext.protected()
  protected EE?: EventEmitter | null;

  @GMContext.API({ follow: "CAT.continuation" })
  public "CAT.continuation.connect"(): Promise<ContinuationShimSubscriptionInfo> {
    return this.sendMessage("CAT_continuation", [{ action: "connect" }]) as Promise<ContinuationShimSubscriptionInfo>;
  }

  @GMContext.API({ follow: "CAT.continuation" })
  public "CAT.continuation.status"(): Promise<ContinuationShimSubscriptionInfo> {
    return this.sendMessage("CAT_continuation", [{ action: "status" }]) as Promise<ContinuationShimSubscriptionInfo>;
  }

  @GMContext.API({ follow: "CAT.continuation" })
  public "CAT.continuation.send"(message: ContinuationShimMessage): Promise<void> {
    return this.sendMessage("CAT_continuation", [{ action: "send", message }]) as Promise<void>;
  }

  @GMContext.API({ follow: "CAT.continuation" })
  public "CAT.continuation.disconnect"(): Promise<void> {
    return this.sendMessage("CAT_continuation", [{ action: "disconnect" }]) as Promise<void>;
  }

  @GMContext.API({ follow: "CAT.continuation" })
  public "CAT.continuation.addListener"(callback: ContinuationListener): number {
    if (!this.EE) return 0;
    const listenerId = ++listenerCounter;
    const eventName = "continuationShim:message";
    this.EE.on(eventName, callback);
    listeners.set(listenerId, { emitter: this.EE, eventName, callback });
    return listenerId;
  }

  @GMContext.API({ follow: "CAT.continuation" })
  public "CAT.continuation.removeListener"(listenerId: number): void {
    const listener = listeners.get(listenerId);
    if (!listener) return;
    listener.emitter.off(listener.eventName, listener.callback);
    listeners.delete(listenerId);
  }
}
