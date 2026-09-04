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
  acknowledgeRealTimeIssueMessages,
  provisionRealTimeIssuesQueue,
  pullRealTimeIssueMessages,
  removeRealTimeIssuesQueue,
  type QueueInstallation,
} from "./real-time-issues-api.js";
import { realTimeIssuesAutomationUrl } from "./resources.js";
import type {
  CloudflareRealTimeIssueHook,
  CloudflareRealTimeIssuesSession,
} from "./types.js";
import TYPES_CODE from "./types.txt";
import { parseRealTimeIssueEvent } from "./real-time-issues-event.js";
import { VENDOR_ID } from "./vendor.js";
import { obsContext } from "./observability.js";

const IDLE_POLL_INTERVAL_MS = 30_000;
const RETRY_POLL_INTERVAL_MS = 10_000;
const PROCESSED_EVENT_TTL_MS = 15 * 24 * 60 * 60 * 1_000;
const PROCESSED_EVENT_CLEANUP_LIMIT = 100;
const PROCESSED_EVENT_PREFIX = "processed-event:";
const PROCESSED_EVENT_INDEX_PREFIX = "processed-event-index:";
const logger = obsContext.createLogger({
  component: "gatekeeper.cloudflare.real-time-issues", vendorId: VENDOR_ID,
});

type RealTimeIssueHookTarget = RpcTarget & CloudflareRealTimeIssueHook;

type RealTimeIssuesProps = {
  userObjectId: string;
  accountId: string;
  installationId: string;
};

function installationId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

@validateRpc()
class CloudflareRealTimeIssuesSessionImpl extends RpcTarget
    implements CloudflareRealTimeIssuesSession {
  constructor(
    private readonly ctx: DurableObjectState<Omit<RealTimeIssuesProps, "installationId">>,
    private readonly approvalQueue: RpcStub<ApprovalQueue>,
  ) {
    super();
  }

  [Symbol.dispose](): void {
    this.approvalQueue[Symbol.dispose]();
  }

  async subscribe(callback: RpcStub<RealTimeIssueHookTarget>): Promise<void> {
    const props: RealTimeIssuesProps = { ...this.ctx.props, installationId: installationId() };
    const controller: Fetcher<HookController<RealTimeIssueHookTarget>> =
      this.ctx.exports.CloudflareRealTimeIssueHookController({ props });
    // @ts-ignore Cap'n Web loses the callback intersection while mapping this generic RPC.
    await this.approvalQueue.bindHook(controller, callback, {
      title: "Investigate Cloudflare Real-Time Issues",
      description: "Receive new Real-Time Issues from the selected Cloudflare account through a " +
        "dedicated Queue and Event Subscription.",
    });
  }
}

@validateRpc()
export class CloudflareRealTimeIssuesGatekeeper
    extends DurableObject<Cloudflare.Env, Omit<RealTimeIssuesProps, "installationId">>
    implements Gatekeeper<CloudflareRealTimeIssuesSession> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: realTimeIssuesAutomationUrl(this.ctx.props.accountId),
      title: "Real-Time Issues automation",
      snippet: "Receive new Workers issues through a managed Queue and Event Subscription.",
      suggestedBindingName: "CLOUDFLARE_REAL_TIME_ISSUES",
      tsType: "CloudflareRealTimeIssuesSession",
      hookTsType: "CloudflareRealTimeIssueHook",
    };
  }

  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
  async getAutoApprovableActions(): Promise<ActionKind[]> { return []; }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<CloudflareRealTimeIssuesSession> {
    return new CloudflareRealTimeIssuesSessionImpl(this.ctx, approvalQueue.dup());
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    // Hook payloads are delivered only to the Gadget that owns the enabled hook. Collaborator access
    // to the resulting Gadget state remains enforced by the Workshop.
  }
  async removeObserver(_id: string): Promise<void> {}

  async applyAction(_action: number, _cache: RpcStub<GitCache>): Promise<void> {
    throw new Error("Real-Time Issues automation exposes hooks, not actions.");
  }
  async rejectAction(_action: number): Promise<void> {
    throw new Error("Real-Time Issues automation exposes hooks, not actions.");
  }
  async revertAction(_action: number): Promise<void> {
    throw new Error("Real-Time Issues automation exposes hooks, not actions.");
  }
}

@validateRpc()
export class CloudflareRealTimeIssueHookController
    extends WorkerEntrypoint<Cloudflare.Env, RealTimeIssuesProps>
    implements HookController<RealTimeIssueHookTarget> {
  #poller(): DurableObjectStub<RealTimeIssuePoller> {
    return this.ctx.exports.RealTimeIssuePoller.getByName(this.ctx.props.installationId);
  }

  async enable(
    initiator: Fetcher<HookInitiator<RealTimeIssueHookTarget>>,
    _target: HookTargetMetadata,
  ): Promise<void> {
    await this.#poller().enable(this.ctx.props, initiator);
  }

  async disable(): Promise<void> {
    await this.#poller().disable();
  }
}

/** Owns one managed Queue installation and wakes itself to pull events. */
export class RealTimeIssuePoller extends DurableObject<Cloudflare.Env> {
  #processedEventKey(eventId: string): string {
    return `${PROCESSED_EVENT_PREFIX}${eventId}`;
  }

  #hasProcessedEvent(eventId: string): boolean {
    return this.ctx.storage.kv.get<number>(this.#processedEventKey(eventId)) !== undefined;
  }

  #recordProcessedEvent(eventId: string): void {
    const processedAt = Date.now();
    const indexKey = `${PROCESSED_EVENT_INDEX_PREFIX}${String(processedAt).padStart(13, "0")}:` +
      crypto.randomUUID();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.put(this.#processedEventKey(eventId), processedAt);
      this.ctx.storage.kv.put(indexKey, eventId);
    });
  }

  #cleanupProcessedEvents(): void {
    const cutoff = Date.now() - PROCESSED_EVENT_TTL_MS;
    const expired: Array<[string, string]> = [];
    for (const [indexKey, eventId] of this.ctx.storage.kv.list<string>({
      prefix: PROCESSED_EVENT_INDEX_PREFIX,
      limit: PROCESSED_EVENT_CLEANUP_LIMIT,
    })) {
      const timestampEnd = indexKey.indexOf(":", PROCESSED_EVENT_INDEX_PREFIX.length);
      const processedAt = Number(indexKey.slice(PROCESSED_EVENT_INDEX_PREFIX.length, timestampEnd));
      if (!Number.isSafeInteger(processedAt) || processedAt > cutoff) break;
      expired.push([indexKey, eventId]);
    }
    if (expired.length === 0) return;
    this.ctx.storage.transactionSync(() => {
      for (const [indexKey, eventId] of expired) {
        if ((this.ctx.storage.kv.get<number>(this.#processedEventKey(eventId)) ?? Infinity) <= cutoff) {
          this.ctx.storage.kv.delete(this.#processedEventKey(eventId));
        }
        this.ctx.storage.kv.delete(indexKey);
      }
    });
  }

  #props(): RealTimeIssuesProps {
    const props = this.ctx.storage.kv.get<RealTimeIssuesProps>("props");
    if (!props) throw new Error("Real-Time Issues poller is not configured.");
    return props;
  }

  #account(props = this.#props()) {
    const id = this.ctx.exports.UserAccount.idFromString(props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  async enable(
    props: RealTimeIssuesProps,
    initiator: Fetcher<HookInitiator<RealTimeIssueHookTarget>>,
  ): Promise<void> {
    const storedProps = this.ctx.storage.kv.get<RealTimeIssuesProps>("props");
    if (storedProps && JSON.stringify(storedProps) !== JSON.stringify(props)) {
      throw new Error("Real-Time Issues poller configuration cannot be changed.");
    }
    let installation = this.ctx.storage.kv.get<QueueInstallation>("installation");
    if (!installation) {
      const token = await this.#account(props).getAccessToken();
      if (!token) throw new Error("Cloudflare OAuth credentials are unavailable while enabling hook.");
      installation = await provisionRealTimeIssuesQueue(
        token,
        props.accountId,
        props.installationId,
      );
      this.ctx.storage.kv.put("props", props);
      this.ctx.storage.kv.put("installation", installation);
    }
    this.ctx.storage.kv.put("initiator", initiator);
    await this.ctx.storage.setAlarm(Date.now());
  }

  async disable(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    this.ctx.storage.kv.delete("initiator");
    const installation = this.ctx.storage.kv.get<QueueInstallation>("installation");
    if (!installation) return;
    const props = this.#props();
    const token = await this.#account(props).getAccessToken();
    if (!token) throw new Error("Cloudflare OAuth credentials are unavailable while disabling hook.");
    await removeRealTimeIssuesQueue(token, props.accountId, installation);
    this.ctx.storage.deleteAll();
  }

  async alarm(): Promise<void> {
    const initiator = this.ctx.storage.kv.get<Fetcher<HookInitiator<RealTimeIssueHookTarget>>>(
      "initiator",
    );
    const installation = this.ctx.storage.kv.get<QueueInstallation>("installation");
    if (!initiator || !installation) return;

    const props = this.#props();
    let nextPoll = RETRY_POLL_INTERVAL_MS;
    try {
      const token = await this.#account(props).getAccessToken();
      if (!token) throw new Error("Cloudflare OAuth credentials are unavailable while polling.");
      const batch = await pullRealTimeIssueMessages(
        token,
        props.accountId,
        installation.queueId,
      );
      this.#cleanupProcessedEvents();
      const acknowledged: string[] = [];
      for (const message of batch.messages) {
        try {
          const event = parseRealTimeIssueEvent(
            message.body,
            props.accountId,
            installation.subscriptionId,
          );
          if (!this.#hasProcessedEvent(event.id)) {
            // @ts-expect-error Worker RPC's mapped return type wraps the disposable hook result.
            using hook = initiator.startHook();
            await hook.approvalQueue.authorizeObservation({
              title: "Cloudflare Real-Time Issue",
              description: `Received Real-Time Issue event ${event.id} from the bound account.`,
            });
            await hook.callback.onIssue(event);
            this.#recordProcessedEvent(event.id);
          }
          acknowledged.push(message.leaseId);
        } catch (error) {
          logger.warn("Real-Time Issue message delivery failed", {
            event: "real_time_issues.delivery.failed",
            accountId: props.accountId,
            queueId: installation.queueId,
            error,
          });
        }
      }
      await acknowledgeRealTimeIssueMessages(
        token,
        props.accountId,
        installation.queueId,
        acknowledged,
      );
      nextPoll = batch.backlog > batch.messages.length ? 0 : IDLE_POLL_INTERVAL_MS;
    } catch (error) {
      logger.error("Real-Time Issues Queue poll failed", {
        event: "real_time_issues.poll.failed",
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
