# Gatekeeper Implementation Skeleton

Replace all `My`/`my`/`MY` prefixes with the service name.

## Main implementation (`src/<name>.ts`)

```typescript
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
  SupportedResource,
} from '@gadgets/workshop-shared/gatekeeper';
import { MySession } from "./types";
import TYPES_CODE from "./types.txt";

type Env = Cloudflare.Env & {
  BASE_URL?: string,
};

function getBaseUrl(env: Env) {
  return env.BASE_URL || "http://localhost:8787/gatekeeper/<name>";
}

function getBasePath(env: Env) {
  return new URL(getBaseUrl(env)).pathname;
}

const SELF_CLOSING_HTML = `<!DOCTYPE html>
<html lang="en">
  <body>
    <script type="text/javascript">window.close();</script>
    <p>Authorization complete. You may close this tab and return to the Gadgets Workshop.
  </body>
</html>`;

const MY_RESOURCE: SupportedResource = {
  urlPattern: "https://example.com/*",
  title: "My Resource",
  description: "Access a specific resource.",
};

// ---------------------------------------------------------------------------
// HTTP handler — serves the OAuth flow

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    // Route OAuth initiation and callback URLs.
    // See gatekeeper-google/src/google.ts for a complete OAuth flow example.
  }
};

// ---------------------------------------------------------------------------
// Vendor — top-level API exposed to the Workshop

export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "My Service",
      url: "https://example.com",
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>): Promise<{url: string}> {
    let userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [MY_RESOURCE];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

// ---------------------------------------------------------------------------
// UserAccount DO — stores the user's credentials

export class UserAccount extends DurableObject<Env> {
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>) {
    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
    }
    this.ctx.storage.kv.put("callback", callback);
  }

  async acceptAuthCode(code: string) {
    let callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      throw new Error("Authorization timed out. Please try again.");
    }

    // TODO: Exchange auth code for tokens via the service's OAuth endpoint
    let refreshToken = "TODO";
    this.ctx.storage.kv.put<string>("refreshToken", refreshToken);

    let props: MyUserImplProps = { userObjectId: this.ctx.id.toString() };
    try {
      await callback.complete(this.ctx.exports.MyUserImpl({ props }));
    } catch (err) {
      this.ctx.storage.kv.delete("refreshToken");
      throw err;
    }
  }

  async getAccessToken(): Promise<string> {
    let refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
    if (!refreshToken) throw new Error("No refresh token set");
    // TODO: Exchange refresh token for access token, with caching
    return "TODO";
  }

  async alarm() {
    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      this.ctx.storage.deleteAll();
    }
  }

  async revoke() {
    // TODO: Revoke token with the external service
    this.ctx.storage.deleteAlarm();
    this.ctx.storage.deleteAll();
  }
}

// ---------------------------------------------------------------------------
// UserImpl — maps resource URLs to gatekeeper DO classes

type MyUserImplProps = {
  userObjectId: string;
};

export class MyUserImpl extends WorkerEntrypoint<Env, MyUserImplProps>
                         implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    // TODO: Fetch account info from external service using stored credentials
    return {
      displayName: "TODO",
      avatar: { url: "" },
      scope: ["TODO: describe authorized access"],
    };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [MY_RESOURCE];
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    // Parse URL to determine resource type and extract identifiers.
    // Return a DO class with props baked in via ctx.exports.<ClassName>({props}).
    // The Overseer will instantiate this class as a facet.
    let props: MyGatekeeperImplProps = {
      userObjectId: this.ctx.props.userObjectId,
      // TODO: resource-specific fields extracted from URL
    };
    return {
      class: this.ctx.exports.MyGatekeeperImpl({ props }),
      resource: MY_RESOURCE,
    };
  }

  async revoke(): Promise<void> {
    let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    await this.ctx.exports.UserAccount.get(id).revoke();
  }
}

// ---------------------------------------------------------------------------
// Action types — use `never` if the gatekeeper has no side-effecting actions

type MyAction = {
  type: "myActionType";
  // ... fields fully describing the action
};

type MyRevertInfo = {
  // ... data needed to undo the action
};

// ---------------------------------------------------------------------------
// GatekeeperImpl DO — per-resource instance, runs as a facet of the Overseer

type MyGatekeeperImplProps = {
  userObjectId: string;
  // ... resource-specific fields (e.g., documentId, repoOwner)
};

export class MyGatekeeperImpl extends DurableObject<Env, MyGatekeeperImplProps>
    implements Gatekeeper<MySession, MyAction, MyRevertInfo> {

  async describe(): Promise<ResourceDescription> {
    return {
      url: "TODO: canonical resource URL",
      title: "TODO",
      snippet: "TODO",
      suggestedBindingName: "MY_RESOURCE",  // Based on type, not instance
      tsType: "MySession",
      // hookTsType: "MyHook",  // Uncomment if hooks are supported
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue<MyAction>>): Promise<MySession> {
    return new MySessionImpl(
      approvalQueue.dup(),  // Always dup() before storing
      // ... API client, props, etc.
    );
  }

  async applyAction(action: MyAction): Promise<void | { revertInfo?: MyRevertInfo }> {
    switch (action.type) {
      case "myActionType":
        // TODO: Perform the action against the external service
        return { revertInfo: { /* ... */ } };
      default:
        throw new Error(`Unknown action type: ${(action as any).type}`);
    }
  }

  async rejectAction(action: MyAction): Promise<void | { restart?: boolean }> {
    // Clean up simulation state for this action.
    // Return { restart: true } if the session can't recover from rejection.
  }

  revertAction(action: MyAction, revertInfo: MyRevertInfo):
      Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    // TODO: Undo the action using revertInfo
    throw new Error("Revert not implemented");
  }

  async setHook(hook: Fetcher<WorkerEntrypoint> | null): Promise<void> {
    // No-op if hooks are not supported.
  }
}

// ---------------------------------------------------------------------------
// SessionImpl — the RPC interface exposed to the Gadget

class MySessionImpl extends RpcTarget implements MySession {
  #approvalQueue: ApprovalQueue<MyAction>;

  constructor(approvalQueue: ApprovalQueue<MyAction>) {
    super();
    this.#approvalQueue = approvalQueue;
  }

  // Example: observation (read). Fetch data, then authorize before returning.
  async getData(): Promise<string> {
    let result = "TODO: fetch from service or cache";

    await this.#approvalQueue.authorizeObservation({
      title: "Read data",
      description: "Fetched data from the service.",
    });

    return result;
  }

  // Example: action (side effect). Submit for approval; do NOT perform here.
  async updateData(newValue: string): Promise<void> {
    let action: MyAction = { type: "myActionType" };

    await this.#approvalQueue.submitAction(action, {
      title: "Update data",
      description: `Update value to: ${newValue}`,
      implementsRevert: true,
    });

    // TODO: Update cache/simulation state so subsequent reads reflect this
  }
}
```

## `wrangler.jsonc`

```jsonc
{
  "name": "gatekeeper-<name>",
  "main": "src/<name>.ts",
  "compatibility_date": "2026-02-02",
  "compatibility_flags": ["experimental", "allow_irrevocable_stub_storage"],
  "migrations": [
    {
      "tag": "v0",
      "new_sqlite_classes": ["UserAccount", "MyGatekeeperImpl"]
    }
  ]
}
```

## Creating the `types.txt` symlink

```bash
cd packages/gatekeeper-<name>/src
ln -s types.d.ts types.txt
```
