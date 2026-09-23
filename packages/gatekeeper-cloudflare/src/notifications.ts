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
  ObservationDescription,
  ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { privateObservers } from "@gadgets/gatekeeper-kit/observers";
import { SerialTaskQueue } from "@gadgets/gatekeeper-kit/serial-queue";
import { obsContext } from "./observability.js";
import {
  provisionNotificationInstallation,
  removeNotificationConnection,
  type NotificationInstallation,
} from "./notifications-api.js";
import {
  generateWebhookApiKey,
  hashWebhookApiKey,
  matchesWebhookApiKey,
  MAX_NOTIFICATION_BODY_BYTES,
  notificationReceiverName,
  notificationWebhookBaseUrl,
  parseNotificationWebhook,
  isWebhookTest,
} from "./notifications-webhook.js";
import { accountNotificationsUrl, NOTIFICATIONS_SCOPE } from "./resources.js";
import type {
  CloudflareNotification,
  CloudflareNotificationHook,
  CloudflareNotificationsSession,
  CloudflareNotificationFilter,
  CloudflareNotificationStatus,
} from "./types.js";
import { VENDOR_ID } from "./vendor.js";
import TYPES_CODE from "./types.txt";

const logger = obsContext.createLogger({
  component: "gatekeeper.cloudflare.notifications",
  vendorId: VENDOR_ID,
});
const observers = privateObservers(
  "Cloudflare notification bindings are private to their connected owner.",
);
const RETENTION_MS = 15 * 24 * 60 * 60 * 1000;
const MAX_RETAINED_DELIVERIES = 10_000;
const MAX_HOOKS = 100;

type NotificationEnv = Cloudflare.Env & {
  BASE_URL?: string;
  NOTIFICATIONS_WEBHOOK_BASE_URL?: string;
};
type HookTarget = RpcTarget & CloudflareNotificationHook;
type NotificationsProps = { userObjectId: string; accountId: string };
type HookProps = NotificationsProps & { hookId: string; filter: CloudflareNotificationFilter };
type StoredHook = { props: HookProps; initiator: Fetcher<HookInitiator<HookTarget>> };
type Installation = NotificationInstallation & NotificationsProps & { authHash: string };

function disposeHook(hook: StoredHook | undefined): void {
  (hook?.initiator as (Fetcher<HookInitiator<HookTarget>> & Partial<Disposable>) | undefined)
    ?.[Symbol.dispose]?.();
}

/** A fixed set of credential shards keeps unknown URLs from creating receiver objects. */
export class CloudflareNotificationRegistry extends DurableObject<NotificationEnv> {
  async authorize(name: string, apiKey: string): Promise<boolean> {
    const hash = this.ctx.storage.kv.get<string>(name);
    return hash !== undefined && matchesWebhookApiKey(apiKey, hash);
  }
  register(name: string, hash: string): void {
    this.ctx.storage.kv.put(name, hash);
  }
  remove(name: string): void {
    this.ctx.storage.kv.delete(name);
  }
}

function registry(env: NotificationEnv, props: NotificationsProps) {
  const name = notificationReceiverName(props.userObjectId, props.accountId);
  return env.NOTIFICATION_REGISTRY.getByName(name.slice(0, 2));
}

function receiver(ctx: DurableObjectState<NotificationsProps>, props: NotificationsProps) {
  return ctx.exports.CloudflareNotificationReceiver.getByName(
    notificationReceiverName(props.userObjectId, props.accountId),
  );
}

function auditIdentifier(value: string | undefined): string {
  if (value === undefined) return "not provided";
  return /^[A-Za-z0-9_./:-]{1,120}$/.test(value) ? value : "value omitted";
}

function notificationObservation(notification: CloudflareNotification): ObservationDescription {
  const alertType = auditIdentifier(notification.alertType);
  return {
    title: `Cloudflare notification: ${alertType}`,
    description: `Receive an authenticated Cloudflare notification for account ${notification.accountId}. ` +
      `Alert type: ${alertType}; policy ID: ${auditIdentifier(notification.policyId)}; ` +
      `event state: ${auditIdentifier(notification.event)}. The body includes free-form text and ` +
      "product-specific evidence.",
    containsRestrictedData: true,
  };
}

@validateRpc()
class CloudflareNotificationsSessionImpl
  extends RpcTarget
  implements CloudflareNotificationsSession
{
  #ctx: DurableObjectState<NotificationsProps>;
  #queue: RpcStub<ApprovalQueue>;
  constructor(ctx: DurableObjectState<NotificationsProps>, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#ctx = ctx;
    this.#queue = queue;
  }
  [Symbol.dispose](): void {
    this.#queue[Symbol.dispose]();
  }
  async subscribe(
    callback: RpcStub<HookTarget>,
    filter: CloudflareNotificationFilter = {},
  ): Promise<void> {
    if (
      [filter.alertTypes, filter.policyIds].some(
        (values) =>
          values && (values.length > 100 || values.some((value) => !value || value.length > 200)),
      )
    ) {
      throw new Error("Use at most 100 non-empty values of at most 200 characters per filter.");
    }
    const props: HookProps = { ...this.#ctx.props, hookId: crypto.randomUUID(), filter };
    const controller = this.#ctx.exports.CloudflareNotificationHookController({ props });
    await this.#queue.bindHook(controller, callback, {
      title: `Cloudflare notifications for ${props.accountId}`,
      description: `Receive notifications from Cloudflare account ${props.accountId}. ` +
        (filter.alertTypes ? `Alert types: ${filter.alertTypes.length} selected. ` : "All alert types. ") +
        (filter.policyIds ? `Policies: ${filter.policyIds.length} selected.` : "All policies."),
    });
  }
  async getStatus(): Promise<CloudflareNotificationStatus> {
    await this.#queue.authorizeObservation({
      title: `Cloudflare notification status for ${this.#ctx.props.accountId}`,
      description: `Read destination ID, subscriber count, and recent delivery times for Cloudflare account ${this.#ctx.props.accountId}.`,
      containsRestrictedData: true,
    });
    return receiver(this.#ctx, this.#ctx.props).getStatus();
  }
}

@validateRpc()
export class CloudflareNotificationsGatekeeper
  extends DurableObject<NotificationEnv, NotificationsProps>
  implements Gatekeeper<CloudflareNotificationsSession>
{
  async describe(): Promise<ResourceDescription> {
    return {
      url: accountNotificationsUrl(this.ctx.props.accountId),
      title: "Cloudflare Notifications",
      snippet: "Receive Cloudflare alerts in this workspace through a managed webhook.",
      suggestedBindingName: "CLOUDFLARE_NOTIFICATIONS",
      tsType: "CloudflareNotificationsSession",
      hookTsType: "CloudflareNotificationHook",
    };
  }
  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }
  async startSession(queue: RpcStub<ApprovalQueue>): Promise<CloudflareNotificationsSession> {
    return new CloudflareNotificationsSessionImpl(this.ctx, queue.dup());
  }
  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    await observers.addObserver(id, user);
  }
  async removeObserver(id: string): Promise<void> {
    await observers.removeObserver(id);
  }
  async applyAction(_action: number, _cache: RpcStub<GitCache>): Promise<void> {
    throw new Error("This resource exposes hooks, not actions.");
  }
  async rejectAction(_action: number): Promise<void> {
    throw new Error("This resource exposes hooks, not actions.");
  }
  async revertAction(_action: number): Promise<void> {
    throw new Error("This resource exposes hooks, not actions.");
  }
}

@validateRpc()
export class CloudflareNotificationHookController
  extends WorkerEntrypoint<NotificationEnv, HookProps>
  implements HookController<HookTarget>
{
  #receiver() {
    return this.ctx.exports.CloudflareNotificationReceiver.getByName(
      notificationReceiverName(this.ctx.props.userObjectId, this.ctx.props.accountId),
    );
  }
  async enable(
    initiator: Fetcher<HookInitiator<HookTarget>>,
    _target: HookTargetMetadata,
  ): Promise<void> {
    await this.#receiver().enable(this.ctx.props, initiator);
  }
  async disable(): Promise<void> {
    await this.#receiver().disable(this.ctx.props.hookId);
  }
}

/** Webhook handoff per connection/account. ANS owns retries; only successful receipts are stored. */
export class CloudflareNotificationReceiver extends DurableObject<NotificationEnv> {
  #mutations = new SerialTaskQueue();
  #provisioning?: Promise<void>;
  #inFlight = new Map<string, Promise<boolean>>();
  constructor(ctx: DurableObjectState, env: NotificationEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS notification_receipts (
      notification_id TEXT NOT NULL, hook_id TEXT NOT NULL, delivered_at INTEGER NOT NULL,
      PRIMARY KEY(notification_id, hook_id))`);
  }

  #account(userObjectId: string) {
    return this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(userObjectId),
    );
  }
  async #hasCredentials(owner: NotificationsProps): Promise<boolean> {
    const account = this.#account(owner.userObjectId);
    const [scopes, token] = await Promise.all([
      account.getGrantedScopes(),
      account.getAccessToken(),
    ]);
    return scopes.includes(NOTIFICATIONS_SCOPE) && token !== null;
  }
  #hooks() {
    return [...this.ctx.storage.kv.list<StoredHook>({ prefix: "hook:" })].map(([, hook]) => hook);
  }
  #hookCount(): number {
    const hooks = this.#hooks();
    for (const hook of hooks) disposeHook(hook);
    return hooks.length;
  }

  async #provision(props: NotificationsProps): Promise<void> {
    const account = this.#account(props.userObjectId);
    if (!(await account.getGrantedScopes()).includes(NOTIFICATIONS_SCOPE)) {
      throw new Error("Reconnect Cloudflare with Notifications access first.");
    }
    const token = await account.getAccessToken();
    if (!token) throw new Error("Reconnect Cloudflare before enabling notifications.");
    const base = notificationWebhookBaseUrl(
      this.env.NOTIFICATIONS_WEBHOOK_BASE_URL ??
        this.env.BASE_URL ??
        "http://localhost:8787/gatekeeper/cloudflare",
    );
    // Record ownership before external side effects, so disconnect can stop incomplete setup.
    await account.registerNotificationAccount(props.accountId);
    const webhookUrl = `${base}/webhooks/${props.userObjectId}/${props.accountId}`;
    this.ctx.storage.kv.put("webhookUrl", webhookUrl);
    const apiKey = generateWebhookApiKey();
    const authHash = await hashWebhookApiKey(apiKey);
    this.ctx.storage.kv.put("pendingAuthHash", authHash);
    this.ctx.storage.kv.put("owner", props);
    const credentialRegistry = registry(this.env, props);
    try {
      await credentialRegistry.register(notificationReceiverName(props.userObjectId, props.accountId), authHash);
      const installation = await provisionNotificationInstallation(
        token,
        props.accountId,
        webhookUrl,
        apiKey,
      );
      this.ctx.storage.kv.put<Installation>("installation", {
        ...installation,
        ...props,
        authHash,
      });
      this.ctx.storage.kv.put("setupComplete", true);
    } catch (error) {
      await credentialRegistry.remove(notificationReceiverName(props.userObjectId, props.accountId));
      throw error;
    } finally {
      this.ctx.storage.kv.delete("pendingAuthHash");
    }
  }

  async enable(props: HookProps, initiator: Fetcher<HookInitiator<HookTarget>>): Promise<void> {
    await this.#mutations.run(async () => {
      const owner = this.ctx.storage.kv.get<NotificationsProps>("owner");
      if (owner && (owner.accountId !== props.accountId || owner.userObjectId !== props.userObjectId))
        throw new Error("Notification receiver belongs to another account.");
      if (this.ctx.storage.kv.get("suspended"))
        throw new Error("This notification connection has been disconnected.");
      const key = `hook:${props.hookId}`;
      const existing = this.ctx.storage.kv.get<StoredHook>(key);
      const alreadyEnabled = existing !== undefined;
      disposeHook(existing);
      if (!alreadyEnabled && this.#hookCount() >= MAX_HOOKS)
        throw new Error("This notification connection has reached its subscriber limit.");
      if (!this.ctx.storage.kv.get("setupComplete")) {
        this.#provisioning = this.#provision(props).finally(() => {
          this.#provisioning = undefined;
        });
        await this.#provisioning;
      }
      if (this.ctx.storage.kv.get("suspended"))
        throw new Error("This notification connection has been disconnected.");
      const replaced = this.ctx.storage.kv.get<StoredHook>(key);
      try {
        this.ctx.storage.kv.put<StoredHook>(key, { props, initiator });
      } finally {
        disposeHook(replaced);
      }
    });
  }

  async disable(hookId: string): Promise<void> {
    await this.#mutations.run(() => {
      const key = `hook:${hookId}`;
      const existing = this.ctx.storage.kv.get<StoredHook>(key);
      this.ctx.storage.kv.delete(key);
      disposeHook(existing);
    });
    await Promise.allSettled([...this.#inFlight]
      .filter(([key]) => key.endsWith(`:${hookId}`)).map(([, delivery]) => delivery));
    this.ctx.storage.sql.exec("DELETE FROM notification_receipts WHERE hook_id = ?", hookId);
  }
  async suspend(): Promise<void> {
    this.ctx.storage.kv.put("suspended", true);
    // Let an already-started callback finish before returning; no subsequent callback may start.
    await Promise.all(this.#inFlight.values());
    await this.#provisioning?.catch(() => undefined);
  }
  async revokeWithToken(token: string): Promise<void> {
    await this.suspend();
    const installation = this.ctx.storage.kv.get<Installation>("installation");
    const owner = this.ctx.storage.kv.get<NotificationsProps>("owner");
    const webhookUrl = this.ctx.storage.kv.get<string>("webhookUrl");
    if (owner && webhookUrl)
      await removeNotificationConnection(token, owner.accountId, webhookUrl, installation);
    if (owner) await registry(this.env, owner).remove(notificationReceiverName(owner.userObjectId, owner.accountId));
    // Keep a tombstone so outstanding controller capabilities cannot resurrect this receiver.
    for (const [key, value] of this.ctx.storage.kv.list()) {
      if (key !== "suspended") this.ctx.storage.kv.delete(key);
      if (key.startsWith("hook:")) disposeHook(value as StoredHook);
    }
    this.ctx.storage.sql.exec("DELETE FROM notification_receipts");
  }

  async getStatus(): Promise<CloudflareNotificationStatus> {
    const installation = this.ctx.storage.kv.get<Installation>("installation");
    return {
      installed: !!this.ctx.storage.kv.get("setupComplete"),
      suspended: !!this.ctx.storage.kv.get("suspended"),
      webhookId: installation?.webhookId,
      subscribers: this.#hookCount(),
      lastTestAt: this.ctx.storage.kv.get<string>("lastTestAt"),
      lastReceivedAt: this.ctx.storage.kv.get<string>("lastReceivedAt"),
    };
  }

  async receiveWebhook(apiKey: string, contentType: string, body: string): Promise<number> {
    if (contentType.split(";")[0]?.trim().toLowerCase() !== "application/json") return 415;
    if (new TextEncoder().encode(body).byteLength > MAX_NOTIFICATION_BODY_BYTES) return 413;
    if (this.ctx.storage.kv.get("suspended")) return 410;
    const installation = this.ctx.storage.kv.get<Installation>("installation");
    const expectedHash =
      this.ctx.storage.kv.get<string>("pendingAuthHash") ?? installation?.authHash;
    if (!expectedHash || !(await matchesWebhookApiKey(apiKey, expectedHash))) return 401;
    let notification: CloudflareNotification;
    try {
      if (isWebhookTest(JSON.parse(body))) {
        this.ctx.storage.kv.put("lastTestAt", new Date().toISOString());
        return 204;
      }
      if (!installation) return 500;
      notification = await parseNotificationWebhook(body, installation.accountId);
    } catch {
      return 400;
    }
    if (!(await this.#hasCredentials(installation!))) return 500;
    // Recheck after hashing yielded: a concurrent disconnect must win over new delivery.
    if (this.ctx.storage.kv.get("suspended")) return 410;
    this.ctx.storage.sql.exec(
      "DELETE FROM notification_receipts WHERE delivered_at < ?",
      Date.now() - RETENTION_MS,
    );
    const available = this.#hooks();
    const hooks = available.filter(
      ({ props: { filter } }) =>
        (!filter.alertTypes || (notification.alertType !== undefined &&
          filter.alertTypes.includes(notification.alertType))) &&
        (!filter.policyIds ||
          (notification.policyId !== undefined &&
            filter.policyIds.includes(notification.policyId))),
    );
    for (const hook of available) if (!hooks.includes(hook)) disposeHook(hook);
    const results = await Promise.all(hooks.map((hook) => this.#handoff(hook, notification)));
    if (results.some((delivered) => !delivered)) return 500;
    if (this.ctx.storage.kv.get("suspended")) return 410;
    this.ctx.storage.kv.put("lastReceivedAt", new Date().toISOString());
    return 204;
  }

  #handoff(stored: StoredHook, notification: CloudflareNotification): Promise<boolean> {
    const key = `${notification.id}:${stored.props.hookId}`;
    const running = this.#inFlight.get(key);
    if (running) {
      disposeHook(stored);
      return running;
    }
    const delivery = this.#deliver(stored, notification).finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, delivery);
    return delivery;
  }

  async #deliver(stored: StoredHook, notification: CloudflareNotification): Promise<boolean> {
    const hookId = stored.props.hookId;
    try {
      if (this.ctx.storage.sql.exec(
        "SELECT 1 FROM notification_receipts WHERE notification_id = ? AND hook_id = ?",
        notification.id, hookId,
      ).toArray().length) return true;
      // The persistent initiator checks current workspace authority on every handoff.
      using hook = await stored.initiator.startHook();
      await hook.approvalQueue.authorizeObservation(notificationObservation(notification));
      if (this.ctx.storage.kv.get("suspended") || !this.ctx.storage.kv.get(`hook:${hookId}`))
        return false;
      await hook.callback.onNotification(notification);
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO notification_receipts VALUES (?, ?, ?)",
        notification.id,
        hookId,
        Date.now(),
      );
      // Bound deduplication storage without retaining event payloads or pending work.
      this.ctx.storage.sql.exec(
        `DELETE FROM notification_receipts WHERE rowid IN (
        SELECT rowid FROM notification_receipts ORDER BY delivered_at DESC LIMIT -1 OFFSET ?
      )`,
        MAX_RETAINED_DELIVERIES,
      );
      return true;
    } catch {
      logger.warn("notification handoff failed", {
        event: "notification.delivery.failed",
        accountId: stored.props.accountId,
      });
      return false;
    } finally {
      disposeHook(stored);
    }
  }
}
