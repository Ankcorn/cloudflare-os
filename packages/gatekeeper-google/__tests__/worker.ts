import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription, ApprovalQueue, GitCache, GitObjectType, GitOid, HookController,
  HookDescription, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { GoogleAccessToken } from "../src/google-api";
import type { GoogleDocSession } from "../src/docs-types";
import type { GoogleDocGatekeeperImpl as GoogleDocGatekeeper } from "../src/google";

export { default, GoogleDocGatekeeperImpl } from "../src/google";

export class UserAccount extends DurableObject<Env> {
  async getAccessToken(): Promise<GoogleAccessToken> {
    return { token: "test-access-token", expires: new Date(8640000000000000) };
  }
}

type GatekeeperProps = { userObjectId: string; documentId: string };

class TestApprovalQueue extends RpcTarget implements ApprovalQueue {
  actionId?: number;

  async authorizeObservation(_description: ObservationDescription): Promise<void> {}

  async getGitCache(): Promise<GitCache> {
    throw new Error("Unexpected git cache access");
  }

  async submitAction(actionId: number, _description: ActionDescription): Promise<void> {
    this.actionId = actionId;
  }

  async bindHook<Hook extends RpcTarget>(
    _controller: Fetcher<HookController<Hook>>,
    _callback: RpcStub<Hook>,
    _description: HookDescription,
  ): Promise<void> {
    throw new Error("Unexpected hook binding");
  }
}

/**
 * Stands in for the git cache the overseer passes to `applyAction()`. This gatekeeper never
 * touches it, so every method just throws.
 */
class TestGitCache extends RpcTarget implements GitCache {
  async get(_id: GitOid): Promise<{type: GitObjectType, content: Uint8Array} | null> {
    throw new Error("not implemented");
  }
  async has(_id: GitOid): Promise<boolean> { throw new Error("not implemented"); }
  async stat(_id: GitOid): Promise<{type: GitObjectType, size: number} | null> {
    throw new Error("not implemented");
  }
  async put(_type: GitObjectType, _content: Uint8Array): Promise<GitOid> {
    throw new Error("not implemented");
  }
  async advertiseCommit(_commitId: GitOid): Promise<void> { throw new Error("not implemented"); }
  async buildPack(): Promise<ReadableStream<Uint8Array>> { throw new Error("not implemented"); }
  async consumePack(_pack: ReadableStream<Uint8Array>): Promise<GitOid[]> {
    throw new Error("not implemented");
  }
  async isAncestor(_ancestor: GitOid, _descendant: GitOid): Promise<boolean> {
    throw new Error("not implemented");
  }
}

export class TestHooks extends DurableObject<Env> {
  #gatekeeper(facetName: string) {
    let userObjectId = this.ctx.exports.UserAccount.idFromName("test-user").toString();
    return this.ctx.facets.get<GoogleDocGatekeeper>(facetName, () => ({
      class: this.ctx.exports.GoogleDocGatekeeperImpl({
        props: { userObjectId, documentId: "doc-1" } satisfies GatekeeperProps,
      }),
    }));
  }

  async submitAppend(facetName: string, markdown: string): Promise<number> {
    let queue = new TestApprovalQueue();
    {
      using approvalQueue = new RpcStub<ApprovalQueue>(queue);
      using session = await this.#gatekeeper(facetName).startSession(
        approvalQueue as unknown as ApprovalQueue,
      ) as GoogleDocSession & Disposable;
      await session.appendText(markdown);
    }
    if (queue.actionId === undefined) throw new Error("Action was not submitted");
    return queue.actionId;
  }

  /** The `lastModified` a metadata read reports, as epoch milliseconds. */
  async readMetadata(facetName: string): Promise<number> {
    using approvalQueue = new RpcStub<ApprovalQueue>(new TestApprovalQueue());
    using session = await this.#gatekeeper(facetName).startSession(
      approvalQueue as unknown as ApprovalQueue,
    ) as GoogleDocSession & Disposable;
    let metadata = await session.getMetadata();
    return metadata.lastModified.valueOf();
  }

  /** The simulated document content a read reports. */
  async readContent(facetName: string): Promise<string> {
    using approvalQueue = new RpcStub<ApprovalQueue>(new TestApprovalQueue());
    using session = await this.#gatekeeper(facetName).startSession(
      approvalQueue as unknown as ApprovalQueue,
    ) as GoogleDocSession & Disposable;
    let content = await session.getContent();
    return content;
  }

  async applyAction(facetName: string, actionId: number): Promise<string | null> {
    try {
      // The overseer always passes an action-scoped git cache with the apply call, and the
      // validator (sharpened by the `Gatekeeper` interface) requires it, so the test passes a
      // stand-in the same way.
      await this.#gatekeeper(facetName).applyAction(actionId, new RpcStub(new TestGitCache()));
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async rejectAction(facetName: string, actionId: number): Promise<void> {
    await this.#gatekeeper(facetName).rejectAction(actionId);
  }
}
