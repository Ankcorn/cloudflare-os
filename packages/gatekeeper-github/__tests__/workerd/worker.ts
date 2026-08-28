// Test worker for the workerd suite. Re-exports the production entrypoints so miniflare can bind
// the Durable Objects, and adds a hook Durable Object for the code that depends on `ctx.props`.
//
// `TestHooks` has to be a Durable Object rather than a WorkerEntrypoint: a `DurableObjectClass`
// from `ctx.exports.X({props})` is only reachable through `ctx.facets`, which is the same way the
// overseer instantiates a gatekeeper in production. And because a stub *to* a facet is not
// serializable, TestHooks cannot hand the facet to the test; it forwards each call instead --
// stubs the test passes (the fake approval queue and git cache) ride through to the facet, and
// results ride back as plain data.

import { DurableObject } from "cloudflare:workers";
import type { RpcStub } from "cloudflare:workers";
import type { ActionDescription, GitCache } from "@gadgets/workshop-shared/gatekeeper";
import type { GitHubGatekeeperImpl } from "../../src/github.js";
import type { GitHubBranchSummary, GitHubCommitDetails } from "../../src/types.js";

export { default } from "../../src/github.js";
export * from "../../src/github.js";

/** Mirrors github.ts's (unexported) `GitHubGatekeeperImplProps`. */
export type GatekeeperProps = {
  userObjectId: string;
  resourceKind: "repo" | "issue" | "pull";
  owner: string;
  repo: string;
  issueNumber?: number;
};

/** Mirrors github.ts's (unexported) `PushAction` record, as the tests read it back. */
export type PushActionData = {
  type: "push";
  approvalId: number;
  submittedAt: number;
  owner: string;
  repo: string;
  branch: string;
  expectedOldSha: string;
  newSha: string;
  force: boolean;
};

type TestExports = {
  GitHubGatekeeperImpl(options: { props: GatekeeperProps }):
    DurableObjectClass<GitHubGatekeeperImpl>;
};

// The facet methods TestHooks forwards to, spelled structurally: workers-types' `Fetcher<T>`
// return-type inference collapses several of these returns to `never` (its `Serializable`
// heuristic gives up on them), while the runtime objects are exactly the production ones.
type GatekeeperFacet = {
  preparePush(branch: string, commitId: string, force: boolean, cache: RpcStub<GitCache>)
    : Promise<PushActionData | null>;
  submitActionForApproval(queue: unknown, action: PushActionData, description: ActionDescription)
    : Promise<void>;
  applyAction(actionId: number, cache: RpcStub<GitCache>): Promise<void>;
  revertAction(actionId: number): Promise<undefined | { message?: string; canRetry?: boolean }>;
  listBranches(filter: undefined, pageSize: number)
    : Promise<{ next(): Promise<GitHubBranchSummary[] | null> }>;
  getCommit(ref: string, cache?: RpcStub<GitCache>)
    : Promise<{ details: GitHubCommitDetails, fromCache: boolean }>;
};

/**
 * A forwarded call's result as plain data. Failures ride back as data rather than as RPC
 * rejections, because an expected rejection crossing the RPC boundary additionally surfaces as
 * an unhandled-rejection report in vitest; the test-side wrapper rethrows `error` locally.
 */
export type Outcome<T> = { ok: T } | { error: string };

async function outcome<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: await fn() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export class TestHooks extends DurableObject<Cloudflare.Env> {
  /**
   * The gatekeeper facet for the given name, instantiating it with `props` on first use. Each
   * distinct scenario should use a fresh facet name: a facet is cached per name, so reusing one
   * silently reuses the first caller's props and storage.
   */
  #gatekeeper(facetName: string, props: GatekeeperProps): GatekeeperFacet {
    return this.ctx.facets.get<GitHubGatekeeperImpl>(facetName, () => ({
      class: (this.ctx.exports as unknown as TestExports).GitHubGatekeeperImpl({ props }),
    })) as unknown as GatekeeperFacet;
  }

  async preparePush(
    facetName: string, props: GatekeeperProps,
    branch: string, commitId: string, force: boolean, cache: RpcStub<GitCache>,
  ): Promise<Outcome<PushActionData | null>> {
    return await outcome(() =>
      this.#gatekeeper(facetName, props).preparePush(branch, commitId, force, cache));
  }

  async submitPush(
    facetName: string, props: GatekeeperProps,
    queue: unknown, action: PushActionData, description: ActionDescription,
  ): Promise<Outcome<void>> {
    return await outcome(() =>
      this.#gatekeeper(facetName, props).submitActionForApproval(queue, action, description));
  }

  async applyAction(
    facetName: string, props: GatekeeperProps, actionId: number, cache: RpcStub<GitCache>,
  ): Promise<Outcome<void>> {
    return await outcome(() => this.#gatekeeper(facetName, props).applyAction(actionId, cache));
  }

  async revertAction(
    facetName: string, props: GatekeeperProps, actionId: number,
  ): Promise<Outcome<undefined | { message?: string; canRetry?: boolean }>> {
    return await outcome(() => this.#gatekeeper(facetName, props).revertAction(actionId));
  }

  /** The first page of `listBranches`, drained inside the DO (cursor stubs cannot ride back). */
  async listBranchesFirstPage(
    facetName: string, props: GatekeeperProps, pageSize: number,
  ): Promise<Outcome<GitHubBranchSummary[] | null>> {
    return await outcome(async () => {
      const cursor = await this.#gatekeeper(facetName, props).listBranches(undefined, pageSize);
      return await cursor.next();
    });
  }

  async getCommit(
    facetName: string, props: GatekeeperProps, ref: string, cache?: RpcStub<GitCache>,
  ): Promise<Outcome<{ details: GitHubCommitDetails, fromCache: boolean }>> {
    return await outcome(() => this.#gatekeeper(facetName, props).getCommit(ref, cache));
  }
}
