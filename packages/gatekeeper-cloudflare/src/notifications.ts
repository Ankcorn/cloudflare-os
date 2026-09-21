import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  ActionKind,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperUserVerifier,
  GitCache,
  ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { ActionJournal, defineActions, type TaggedAction } from "@gadgets/gatekeeper-kit/actions";
import { provisionNotificationInstallation } from "./notifications-api.js";
import { accountNotificationsUrl } from "./resources.js";
import type { CloudflareNotificationDestination, CloudflareNotificationsSession } from "./types.js";
import { VENDOR_ID } from "./vendor.js";
import TYPES_CODE from "./types.txt";

type Env = Cloudflare.Env;
type Props = { userObjectId: string; accountId: string };
type ProvisionAction = { destination: CloudflareNotificationDestination };
type Actions = { provision: ProvisionAction };

class NotificationsApi {
  constructor(
    private readonly getToken: () => Promise<string | null>,
    private readonly accountId: string,
  ) {}

  async provision({ destination }: ProvisionAction): Promise<void> {
    const token = await this.getToken();
    if (!token) throw new Error("Reconnect Cloudflare before provisioning notifications.");
    await provisionNotificationInstallation(
      token,
      this.accountId,
      destination.url,
      destination.headerValue,
      destination.name,
    );
  }
}

const definitions = defineActions<NotificationsApi, Actions>(
  {
    provision: {
      kind: {
        tag: "provision-notification-destination",
        label: "Configure notification destination",
      },
      delivery: "await-decision",
      describe: ({ destination }) => ({
        title: `Configure ${destination.name ?? "Cloudflare OS"} notification destination`,
        description: `Send Cloudflare notifications to ${destination.url}.`,
        implementsRevert: false,
      }),
      apply: (action, api) => api.provision(action),
    },
  },
  { fence: "authority", vendorId: VENDOR_ID },
);

function validateDestination(
  value: CloudflareNotificationDestination,
): CloudflareNotificationDestination {
  const url = new URL(value.url);
  if (url.protocol !== "https:") throw new Error("Notification webhook URLs must use HTTPS.");
  if (value.headerName.toLowerCase() !== "cf-webhook-auth") {
    throw new Error("Cloudflare Notifications requires the cf-webhook-auth header.");
  }
  if (!value.headerValue || value.headerValue.length > 1024 || /[\r\n]/.test(value.headerValue)) {
    throw new Error("Invalid notification webhook secret.");
  }
  const name = value.name?.trim();
  if (name !== undefined && (!name || name.length > 128)) {
    throw new Error("Notification destination names must be 1 to 128 characters.");
  }
  return {
    url: url.toString(),
    headerName: "cf-webhook-auth",
    headerValue: value.headerValue,
    ...(name ? { name } : {}),
  };
}

@validateRpc()
class CloudflareNotificationsSessionImpl
  extends RpcTarget
  implements CloudflareNotificationsSession
{
  constructor(
    private readonly actions: ReturnType<typeof definitions.bind>,
    private readonly queue: RpcStub<ApprovalQueue>,
    private readonly accountId: string,
  ) {
    super();
  }

  [Symbol.dispose](): void {
    this.queue[Symbol.dispose]();
  }

  async provisionNotificationInstallation(
    destination: CloudflareNotificationDestination,
  ): Promise<void> {
    await this.actions.submit(
      this.queue,
      "provision",
      { destination: validateDestination(destination) },
      { fence: { generation: this.accountId } },
    );
  }
}

@validateRpc()
export class CloudflareNotificationsGatekeeper
  extends DurableObject<Env, Props>
  implements Gatekeeper<CloudflareNotificationsSession>
{
  readonly #actions: ReturnType<typeof definitions.bind>;

  constructor(ctx: DurableObjectState<Props>, env: Env) {
    super(ctx, env);
    const account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId),
    );
    const api = new NotificationsApi(() => account.getAccessToken(), this.ctx.props.accountId);
    const journal = new ActionJournal<TaggedAction<Actions>>(ctx.storage.kv, {
      namespace: "notifications",
    });
    this.#actions = definitions.bind(journal, api);
  }

  async describe(): Promise<ResourceDescription> {
    return {
      url: accountNotificationsUrl(this.ctx.props.accountId),
      title: "Cloudflare Notifications destination",
      snippet: "Configure an authenticated webhook destination for this account.",
      suggestedBindingName: "CLOUDFLARE_NOTIFICATIONS",
      tsType: "CloudflareNotificationsSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return this.#actions.autoApprovableKinds();
  }
  async startSession(queue: RpcStub<ApprovalQueue>): Promise<CloudflareNotificationsSession> {
    return new CloudflareNotificationsSessionImpl(
      this.#actions,
      queue.dup(),
      this.ctx.props.accountId,
    );
  }
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error("Sharing Cloudflare Notifications resources is not supported yet.");
  }
  async removeObserver(_id: string): Promise<void> {}
  async applyAction(action: number, _cache: RpcStub<GitCache>): Promise<void> {
    await this.#actions.apply(action, { generation: this.ctx.props.accountId });
  }
  async rejectAction(action: number): Promise<void> {
    await this.#actions.reject(action);
  }
  async revertAction(_action: number): Promise<void> {
    throw new Error("Notification destination provisioning cannot be reverted here.");
  }
}
