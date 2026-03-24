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

const NONCE_BYTES = 32;
const NONCE_LIFETIME_MS = 10 * 60 * 1000;  // 10 minutes

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

function constantTimeEqual(a: string, b: string): boolean {
  let encoder = new TextEncoder();
  let bufA = encoder.encode(a);
  let bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

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
// HTTP handler — serves the browser-based auth flow.
// For a complete OAuth example, see gatekeeper-google/src/google.ts.

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    let url = new URL(req.url);
    let basePath = getBasePath(env);
    if (!url.pathname.startsWith(basePath + "/") && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }
    let relPath = url.pathname.slice(basePath.length);
    let path = relPath.slice(1).split("/");

    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      // Auth initiation: the user has visited the connect URL.
      let doId = path[0];
      let nonce = path[1];
      let stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      if (!await stub.verifyNonce(nonce)) {
        // Show a friendly error page for expired/replayed links.
        return new Response("TODO: error HTML", {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }

      // TODO: Redirect to external auth provider, or present an auth form.
      // For OAuth, generate a second nonce for the `state` parameter here —
      // see gatekeeper-google for the full pattern.
      throw new Error("TODO: implement auth initiation");
    } else {
      return new Response("Not Found", {status: 404});
    }
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
    let nonce = generateNonce();
    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback, nonce);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${nonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [MY_RESOURCE];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

// ---------------------------------------------------------------------------
// UserAccount DO — stores per-user credentials (tokens, API keys, etc.).
// For a full OAuth implementation with two-phase nonces and reconnect support,
// see gatekeeper-google.
export class UserAccount extends DurableObject<Env> {
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, nonce: string) {
    // Self-destruct if the connect flow is never completed.
    if (!this.ctx.storage.kv.get<string>("credentials")) {
      this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
    }
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put("nonce", { value: nonce, expiresAt: Date.now() + NONCE_LIFETIME_MS });
  }

  // Verify and consume the nonce from the initiation URL. Prevents replay.
  // Returns false if the nonce is invalid or expired.
  async verifyNonce(nonce: string): Promise<boolean> {
    let stored = this.ctx.storage.kv.get<{value: string, expiresAt: number}>("nonce");
    if (!stored || Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, nonce)) {
      return false;
    }
    this.ctx.storage.kv.delete("nonce");
    return true;
  }

  // Called when the user completes authorization. Store credentials and notify the workshop.
  async completeConnection(/* auth result params */) {
    let callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      throw new Error("Authorization timed out. Please try again.");
    }

    // TODO: Store credentials obtained from the auth flow
    this.ctx.storage.kv.put<string>("credentials", "TODO");

    let props: MyUserImplProps = { userObjectId: this.ctx.id.toString() };
    try {
      await callback.complete(this.ctx.exports.MyUserImpl({ props }));
    } catch (err) {
      this.ctx.storage.kv.delete("credentials");
      throw err;
    }
  }

  async alarm() {
    if (!this.ctx.storage.kv.get<string>("credentials")) {
      this.ctx.storage.deleteAll();
    }
  }

  async revoke() {
    // TODO: Revoke credentials with the external service
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
