import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  ActionKind,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperUserVerifier,
  GitCache,
  HookController,
  HookInitiator,
  HookTargetMetadata,
  ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  acknowledgeCloudflareEventMessages,
  provisionEventSubscription,
  pullCloudflareEventMessages,
  removeEventSubscription,
  type EventSubscriptionInstallation,
} from "./event-subscriptions-api.js";
import { eventSubscriptionsUrl } from "./resources.js";
import type {
  CloudflareEventHook,
  CloudflareEventSubscriptionSession,
  CloudflareEventSubscriptionSpec,
} from "./types.js";
import TYPES_CODE from "./types.txt";
import {
  parseCloudflareEvent,
  parseEventSubscriptionSpec,
} from "./event-subscriptions-event.js";
import { VENDOR_ID } from "./vendor.js";
import { obsContext } from "./observability.js";

const IDLE_POLL_INTERVAL_MS = 30_000;
const RETRY_POLL_INTERVAL_MS = 10_000;
const PROCESSED_EVENT_TTL_MS = 15 * 24 * 60 * 60 * 1_000;
const PROCESSED_EVENT_CLEANUP_LIMIT = 100;
const logger = obsContext.createLogger({
  component: "gatekeeper.cloudflare.events", vendorId: VENDOR_ID,
});

type CloudflareEventHookTarget = RpcTarget & CloudflareEventHook;

type EventSubscriptionsProps = {
  userObjectId: string;
  accountId: string;
};

type EventSubscriptionInstallationProps = EventSubscriptionsProps & {
  installationId: string;
  subscription: CloudflareEventSubscriptionSpec;
};

function installationId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

@validateRpc()
class CloudflareEventSubscriptionSessionImpl extends RpcTarget
    implements CloudflareEventSubscriptionSession {
  constructor(
    private readonly ctx: DurableObjectState<EventSubscriptionsProps>,
    private readonly approvalQueue: RpcStub<ApprovalQueue>,
  ) {
    super();
  }

  [Symbol.dispose](): void {
    this.approvalQueue[Symbol.dispose]();
  }

  async subscribe(
    requestedSubscription: CloudflareEventSubscriptionSpec,
    callback: RpcStub<CloudflareEventHookTarget>,
  ): Promise<void> {
    const subscription = parseEventSubscriptionSpec(requestedSubscription);
    const props: EventSubscriptionInstallationProps = {
      ...this.ctx.props,
      installationId: installationId(),
      subscription,
    };
    const controller: Fetcher<HookController<CloudflareEventHookTarget>> =
      this.ctx.exports.CloudflareEventHookController({ props });
    // @ts-ignore Cap'n Web loses the callback intersection while mapping this generic RPC.
    await this.approvalQueue.bindHook(controller, callback, {
      title: `Subscribe to ${subscription.source.service} events`,
      description: `Receive ${subscription.events.join(", ")} from ` +
        `${JSON.stringify(subscription.source)} in the selected Cloudflare account.`,
    });
  }
}

@validateRpc()
export class CloudflareEventSubscriptionsGatekeeper
    extends DurableObject<Cloudflare.Env, EventSubscriptionsProps>
    implements Gatekeeper<CloudflareEventSubscriptionSession> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: eventSubscriptionsUrl(this.ctx.props.accountId),
      title: "Cloudflare Event Subscriptions",
      snippet: "Receive selected account events through managed Event Subscriptions.",
      suggestedBindingName: "CLOUDFLARE_EVENTS",
      tsType: "CloudflareEventSubscriptionSession",
      hookTsType: "CloudflareEventHook",
    };
  }

  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
  async getAutoApprovableActions(): Promise<ActionKind[]> { return []; }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<CloudflareEventSubscriptionSession> {
    return new CloudflareEventSubscriptionSessionImpl(this.ctx, approvalQueue.dup());
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    // Hook payloads are delivered only to the Gadget that owns the enabled hook. Collaborator access
    // to the resulting Gadget state remains enforced by the Workshop.
  }
  async removeObserver(_id: string): Promise<void> {}

  async applyAction(_action: number, _cache: RpcStub<GitCache>): Promise<void> {
    throw new Error("Cloudflare Event Subscriptions expose hooks, not actions.");
  }
  async rejectAction(_action: number): Promise<void> {
    throw new Error("Cloudflare Event Subscriptions expose hooks, not actions.");
  }
  async revertAction(_action: number): Promise<void> {
    throw new Error("Cloudflare Event Subscriptions expose hooks, not actions.");
  }
}

@validateRpc()
export class CloudflareEventHookController
    extends WorkerEntrypoint<Cloudflare.Env, EventSubscriptionInstallationProps>
    implements HookController<CloudflareEventHookTarget> {
  #poller(): DurableObjectStub<CloudflareEventSubscriptionPoller> {
    return this.ctx.exports.CloudflareEventSubscriptionPoller.getByName(this.ctx.props.installationId);
  }

  async enable(
    initiator: Fetcher<HookInitiator<CloudflareEventHookTarget>>,
    _target: HookTargetMetadata,
  ): Promise<void> {
    await this.#poller().enable(this.ctx.props, initiator);
  }

  async disable(): Promise<void> {
    await this.#poller().disable();
  }
}

/** Owns one managed Queue installation and wakes itself to pull events. */
export class CloudflareEventSubscriptionPoller extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS processed_events (
        id TEXT PRIMARY KEY,
        processed_at INTEGER NOT NULL
      )
    `);
  }

  #hasProcessedEvent(eventId: string): boolean {
    return [...this.ctx.storage.sql.exec(
      "SELECT 1 FROM processed_events WHERE id = ? LIMIT 1", eventId,
    )].length > 0;
  }

  #recordProcessedEvent(eventId: string): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO processed_events (id, processed_at) VALUES (?, ?)",
      eventId,
      Date.now(),
    );
  }

  #cleanupProcessedEvents(): void {
    this.ctx.storage.sql.exec(`
      DELETE FROM processed_events WHERE id IN (
        SELECT id FROM processed_events WHERE processed_at <= ?
        ORDER BY processed_at LIMIT ?
      )
    `, Date.now() - PROCESSED_EVENT_TTL_MS, PROCESSED_EVENT_CLEANUP_LIMIT);
  }

  #props(): EventSubscriptionInstallationProps {
    const props = this.ctx.storage.kv.get<EventSubscriptionInstallationProps>("props");
    if (!props) throw new Error("Event Subscription poller is not configured.");
    return props;
  }

  #account(props = this.#props()) {
    const id = this.ctx.exports.UserAccount.idFromString(props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  async enable(
    props: EventSubscriptionInstallationProps,
    initiator: Fetcher<HookInitiator<CloudflareEventHookTarget>>,
  ): Promise<void> {
    if (!this.ctx.storage.kv.get<EventSubscriptionInstallation>("installation")) {
      const token = await this.#account(props).getAccessToken();
      if (!token) throw new Error("Cloudflare OAuth credentials are unavailable while enabling hook.");
      const created = await provisionEventSubscription(
        token,
        props.accountId,
        props.installationId,
        props.subscription,
      );
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.kv.put("props", props);
        this.ctx.storage.kv.put("installation", created);
      });
    }
    this.ctx.storage.kv.put("initiator", initiator);
    await this.ctx.storage.setAlarm(Date.now());
  }

  async disable(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    this.ctx.storage.kv.delete("initiator");
    const installation = this.ctx.storage.kv.get<EventSubscriptionInstallation>("installation");
    if (!installation) return;
    const props = this.#props();
    const token = await this.#account(props).getAccessToken();
    if (!token) throw new Error("Cloudflare OAuth credentials are unavailable while disabling hook.");
    await removeEventSubscription(token, props.accountId, installation);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.delete("props");
      this.ctx.storage.kv.delete("installation");
    });
    this.ctx.storage.sql.exec("DELETE FROM processed_events");
  }

  async alarm(): Promise<void> {
    const initiator = this.ctx.storage.kv.get<Fetcher<HookInitiator<CloudflareEventHookTarget>>>(
      "initiator",
    );
    const installation = this.ctx.storage.kv.get<EventSubscriptionInstallation>("installation");
    if (!initiator || !installation) return;

    const props = this.#props();
    let nextPoll = RETRY_POLL_INTERVAL_MS;
    try {
      const token = await this.#account(props).getAccessToken();
      if (!token) throw new Error("Cloudflare OAuth credentials are unavailable while polling.");
      const batch = await pullCloudflareEventMessages(
        token,
        props.accountId,
        installation.queueId,
      );
      this.#cleanupProcessedEvents();
      const acknowledged: string[] = [];
      for (const message of batch.messages) {
        try {
          const event = parseCloudflareEvent(
            message.body,
            props.accountId,
            installation.subscriptionId,
            props.subscription,
          );
          if (!this.#hasProcessedEvent(event.id)) {
            // @ts-expect-error Worker RPC's mapped return type wraps the disposable hook result.
            using hook = initiator.startHook();
            await hook.approvalQueue.authorizeObservation({
              title: "Cloudflare event",
              description: `Received ${event.type} event ${event.id} from the bound account.`,
            });
            await hook.callback.onEvent(event);
            this.#recordProcessedEvent(event.id);
          }
          acknowledged.push(message.leaseId);
        } catch (error) {
          logger.warn("Cloudflare event delivery failed", {
            event: "cloudflare_events.delivery.failed",
            accountId: props.accountId,
            queueId: installation.queueId,
            error,
          });
        }
      }
      await acknowledgeCloudflareEventMessages(
        token,
        props.accountId,
        installation.queueId,
        acknowledged,
      );
      nextPoll = batch.backlog > batch.messages.length ? 0 : IDLE_POLL_INTERVAL_MS;
    } catch (error) {
      logger.error("Cloudflare Events Queue poll failed", {
        event: "cloudflare_events.poll.failed",
        accountId: props.accountId,
        queueId: installation.queueId,
        error,
      });
    } finally {
      if (this.ctx.storage.kv.get("initiator")) {
        await this.ctx.storage.setAlarm(Date.now() + nextPoll);
      }
    }
  }
}
