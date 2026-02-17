import { WorkerEntrypoint, DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";
import {
  GatekeeperUser,
  GatekeeperVendor as GatekeeperVendorIface,
  Gatekeeper,
  ResourceDescription,
  ApprovalQueue,
  VendorDescription,
  GatekeeperConnectCallback,
  AccountDescription,
} from '@gadgets/workshop-shared/gatekeeper';
import {
  EmailSession,
  IncomingEmail,
  EmailAddress as EmailAddressType,
  EmailAttachment,
} from "./types";
import PostalMime from "postal-mime";
import type { Email } from "postal-mime";
import TYPES_CODE from "./types.txt";

// Declare optional environment variables here since they may be omitted from wrangler.jsonc.
type Env = Cloudflare.Env & {
  // Origin (protocol+host) on which the default fetch handler is served. Should NOT include a
  // trailing slash. Omit for localhost dev server (which annoyingly has to use different hostnames
  // for different functions).
  ORIGIN?: string,
}

function getOrigin(env: Env) {
  return env.ORIGIN || "http://email.localhost:8787";
}

function getSupportedUrls(env: Env) {
  return [`${getOrigin(env)}/mailbox/*`];
}

function getEmailHost(env: Env) {
  // TODO: This is actually a lie, as email routing can be configured on an entirely different
  //   domain and forwarded to this worker. We only really care about the name before the `@` for
  //   routing purposes. At present the returned host isn't really used anywhere important so
  //   maybe we can get rid of this entirely, or maybe we should bring back the env var that
  //   specifies the default host.
  return new URL(getOrigin(env)).hostname;
}

// =======================================================================================

const SELF_CLOSING_HTML = `<!DOCTYPE html>
<html lang="en">
  <body>
    <script type="text/javascript">window.close();</script>
    <p>Authorization complete. You may close this tab and return to the Gadgets Workshop.
  </body>
</html>`;

// =======================================================================================
// Default export: fetch handler (for connectAccount flow) and email handler (for inbound).

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    let url = new URL(req.url);
    let path = url.pathname.slice(1).split("/");

    if (path.length === 1 && path[0].length === 64) {
      // This is a connectAccount completion URL. Route to the UserAccount DO.
      let userObjectId = ctx.exports.UserAccount.idFromString(path[0]);
      let stub: DurableObjectStub<UserAccount> = ctx.exports.UserAccount.get(userObjectId);
      await stub.complete();
      return new Response(SELF_CLOSING_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8"
        }
      });
    } else {
      return new Response("Not Found", { status: 404 });
    }
  },

  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
    // Parse the recipient address to extract the local part (username).
    let toAddress = message.to;
    let atIndex = toAddress.indexOf("@");
    if (atIndex < 0) {
      message.setReject("Invalid recipient address");
      return;
    }
    let name = toAddress.slice(0, atIndex);

    // Route to the EmailAddress DO for this username.
    let stub: DurableObjectStub<EmailAddress> =
        ctx.exports.EmailAddress.getByName(name);

    // Parse the email using postal-mime.
    let parsed: Email = await PostalMime.parse(message.raw);

    // Build the structured IncomingEmail.
    let from: EmailAddressType = parsed.from
        ? { name: parsed.from.name || "", address: parsed.from.address || "" }
        : { name: "", address: message.from };

    let to: EmailAddressType[] = (parsed.to || []).map(addr => ({
      name: addr.name || "",
      address: addr.address || "",
    }));

    let cc: EmailAddressType[] = (parsed.cc || []).map(addr => ({
      name: addr.name || "",
      address: addr.address || "",
    }));

    let attachments: EmailAttachment[] = (parsed.attachments || []).map(att => ({
      filename: att.filename || null,
      mimeType: att.mimeType,
      disposition: att.disposition || null,
      content: att.content as ArrayBuffer,
    }));

    let incomingEmail: IncomingEmail = {
      from,
      to,
      cc,
      subject: parsed.subject || "",
      date: parsed.date || new Date().toISOString(),
      text: parsed.text || null,
      html: parsed.html || null,
      attachments,
    };

    try {
      await stub.receiveEmail(incomingEmail);
    } catch (err) {
      console.error(err);
      // If no hook is configured or delivery fails, reject the email.
      message.setReject("Delivery failed: " + err);
    }
  }
};

// =======================================================================================
// Top-level API exposed to the Workshop.

export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  status() {
    return "Email Gatekeeper";
  }

  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Email",
      url: getOrigin(this.env),
      // TODO: logo
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>): Promise<{url: string}> {
    let userObjectId = this.ctx.exports.UserAccount.newUniqueId();

    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback);

    return {
      url: `${getOrigin(this.env)}/${userObjectId.toString()}`
    };
  }

  async getSupportedUrls(): Promise<string[]> {
    return getSupportedUrls(this.env);
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

// =======================================================================================
// UserAccount DO: ephemeral, handles the connectAccount flow.
//
// Since email doesn't require OAuth, this DO just stores the callback and completes
// immediately when the user visits the connection URL.

export class UserAccount extends DurableObject<Env> {
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>) {
    // Self-delete after 1 hour if never completed.
    this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);

    this.ctx.storage.kv.put("callback", callback);
  }

  async complete() {
    let callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      throw new Error("Connection already completed or expired. Please try again.");
    }

    let props: GatekeeperUserImplProps = {};
    await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props }));

    // Clean up.
    this.ctx.storage.deleteAlarm();
    this.ctx.storage.deleteAll();
  }

  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    // Timed out without completion -- clean up.
    this.ctx.storage.deleteAll();
  }
}

// =======================================================================================

type GatekeeperUserImplProps = {};

export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps>
                                implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "Email Receiver",
      avatar: { url: "" },  // TODO: email icon
      scope: ["Receive inbound emails"],
    };
  }

  async getSupportedUrls(): Promise<string[]> {
    return getSupportedUrls(this.env);
  }

  async getGatekeeperClassFor(url: string): Promise<DurableObjectClass<Gatekeeper<any>>> {
    // Parse the URL to extract the email name.
    // URL format: https://hostname/mailbox/<name>
    let parsed = new URL(url);
    let emailName = parsed.pathname.slice("/mailbox/".length);
    if (!parsed.pathname.startsWith("/mailbox/") || !emailName) {
      throw new Error(`Invalid email URL: ${url}`);
    }

    let props: EmailGatekeeperImplProps = { emailName };
    return this.ctx.exports.EmailGatekeeperImpl({ props });
  }

  async revoke(): Promise<void> {
    // Nothing to revoke -- email doesn't use external credentials.
  }
}

// =======================================================================================

class EmailSessionImpl extends RpcTarget implements EmailSession {
  #emailName: string;
  #emailHost: string;

  constructor(emailName: string, emailHost: string) {
    super();
    this.#emailName = emailName;
    this.#emailHost = emailHost;
  }

  async getAddress(): Promise<string> {
    return `${this.#emailName}@${this.#emailHost}`;
  }
}

// =======================================================================================

type EmailGatekeeperImplProps = {
  emailName: string;
};

export class EmailGatekeeperImpl extends DurableObject<Env, EmailGatekeeperImplProps>
    implements Gatekeeper<EmailSession, never, never> {

  async describe(): Promise<ResourceDescription> {
    let emailName = this.ctx.props.emailName;
    let host = getEmailHost(this.env);
    return {
      url: `${getOrigin(this.env)}/mailbox/${emailName}`,
      title: `${emailName}@${host}`,
      snippet: `Receive emails sent to ${emailName}@${host}`,
      suggestedBindingName: "EMAIL",
      tsType: "EmailSession",
      hookTsType: "EmailHook",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue<never>>): Promise<EmailSession> {
    let emailName = this.ctx.props.emailName;
    let host = getEmailHost(this.env);
    return new EmailSessionImpl(emailName, host);
  }

  // ---------------------------------------------------------------------------

  async applyAction(action: never): Promise<void> {
    throw new Error("Email gatekeeper has no actions");
  }

  async rejectAction(action: never): Promise<void> {
    // No actions to reject.
  }

  revertAction(action: never, revertInfo: never):
      Promise<void | {message?: string, canRetry?: boolean, restart?: boolean}> {
    throw new Error("Email gatekeeper has no actions to revert");
  }

  async setHook(hook: Fetcher<WorkerEntrypoint> | null): Promise<void> {
    // Forward the hook to the EmailAddress DO for this email name.
    let emailName = this.ctx.props.emailName;
    let stub: DurableObjectStub<EmailAddress> =
        this.ctx.exports.EmailAddress.getByName(emailName);
    await stub.setHook(hook);
  }
}

// =======================================================================================
// EmailAddress DO: per-address durable object.
//
// Named by the local part of the email address (the part before @).
// Stores the hook Fetcher and dispatches inbound emails to it.

export class EmailAddress extends DurableObject<Env> {
  async setHook(hook: Fetcher | null): Promise<void> {
    if (hook) {
      this.ctx.storage.kv.put("hook", hook);
    } else {
      this.ctx.storage.kv.delete("hook");
    }
  }

  async receiveEmail(email: IncomingEmail): Promise<void> {
    let hook = this.ctx.storage.kv.get<Fetcher>("hook");
    if (!hook) {
      throw new Error("No hook configured for this email address");
    }

    // The hook is a Fetcher to a WorkerEntrypoint implementing the EmailHook interface.
    // We call receiveEmail() via RPC.
    await (hook as any).receiveEmail(email);
  }
}
