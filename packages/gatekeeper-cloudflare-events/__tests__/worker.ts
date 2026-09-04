import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription,
  ApprovalQueue,
  GatekeeperUserVerifier,
  GitCache,
  GitObjectType,
  GitOid,
  HookController,
  HookDescription,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { CloudflareEventHook, CloudflareEventSubscriptionSession } from "../src/types.js";
import type { CloudflareEventSubscriptionsGatekeeper } from "../src/cloudflare.js";

export { default } from "../src/cloudflare.js";
export * from "../src/cloudflare.js";
export { CloudflareEventHookController } from "../src/event-subscriptions.js";

class TestApprovalQueue extends RpcTarget implements ApprovalQueue {
  hook?: HookDescription;
  async authorizeObservation(_description: ObservationDescription): Promise<void> {}
  async getGitCache(): Promise<GitCache> { throw new Error("Unexpected git cache access"); }
  async submitAction(_action: number, _description: ActionDescription): Promise<void> {}
  async bindHook<Hook extends RpcTarget>(
    _controller: Fetcher<HookController<Hook>>,
    _callback: RpcStub<Hook>,
    description: HookDescription,
  ): Promise<void> { this.hook = description; }
}

class TestEventCallback extends RpcTarget implements CloudflareEventHook {
  async onEvent(): Promise<void> {}
}

type Props = { userObjectId: string; accountId: string };
type TestExports = {
  CloudflareEventSubscriptionsGatekeeper(options: { props: Props }):
    DurableObjectClass<CloudflareEventSubscriptionsGatekeeper>;
};

export class TestHooks extends DurableObject<Env> {
  #gatekeeper(name: string, props: Props) {
    const exports = this.ctx.exports as unknown as TestExports;
    return this.ctx.facets.get<CloudflareEventSubscriptionsGatekeeper>(name, () => ({
      class: exports.CloudflareEventSubscriptionsGatekeeper({ props }),
    }));
  }

  async describeEventSubscription(name: string, props: Props) {
    const { url, title, suggestedBindingName } = await this.#gatekeeper(name, props).describe();
    return { url, title, suggestedBindingName };
  }

  async subscribeToEvents(
    name: string,
    props: Props,
    subscription: Parameters<CloudflareEventSubscriptionSession["subscribe"]>[0],
  ): Promise<HookDescription | { error: string }> {
    try {
      const queue = new TestApprovalQueue();
      const session = await this.#gatekeeper(name, props).startSession(
        new RpcStub(queue) as unknown as ApprovalQueue,
      );
      await session.subscribe(subscription, new RpcStub(new TestEventCallback()));
      if (!queue.hook) throw new Error("Event subscription was not registered.");
      return queue.hook;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
}
