// Wiring coverage for session-side commit advertising: every commit id a session read returns
// must be advertised to the workspace git cache, or a later attempt to mount it as a worktree
// fails as unknown. The pure helpers are tested in Node (git-commits.test.ts); only this suite can
// catch a session method that forgets to wrap its cursor or advertise its shas -- removing any
// `#gitCache.wrap()`/`#gitCache.advertise()` call in github.ts must fail this file.
//
// Sessions are instantiated directly against fake gatekeepers (the same shape as
// gatekeeper-cloudflare's workerd session suite): the REST/caching layer below the session is not
// under test here, only the session's own wiring.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import { describe, expect, it } from "vitest";
import type { GitHubGatekeeperImpl } from "../../src/github";
import { GitHubPullRequestImpl, GitHubRepoSessionImpl } from "../../src/github";
import type {
  Cursor,
  GitHubCommitSummary,
  GitHubPullRequestSummary,
  GitHubRepoRef,
} from "../../src/types";

/** Deterministic fake full commit id. */
function oid(n: number): string {
  return n.toString(16).padStart(40, "0");
}

class TestGitCache extends RpcTarget {
  readonly advertised: string[] = [];

  async advertiseCommit(commitId: string): Promise<void> {
    this.advertised.push(commitId);
  }
}

class TestApprovalQueue extends RpcTarget {
  readonly observations: string[] = [];
  readonly cache = new TestGitCache();

  async authorizeObservation(entry: { title: string }): Promise<void> {
    this.observations.push(entry.title);
  }

  async getGitCache(): Promise<TestGitCache> {
    return this.cache;
  }
}

function queueStub(queue: TestApprovalQueue): RpcStub<ApprovalQueue> {
  return new RpcStub(queue) as unknown as RpcStub<ApprovalQueue>;
}

/** A cursor over pre-baked pages, as the gatekeeper layer would return. */
function pagesCursor<T>(pages: T[][]): Cursor<T> {
  let index = 0;
  return {
    async next(): Promise<T[] | null> {
      return index >= pages.length ? null : pages[index++];
    },
  };
}

const REPO: GitHubRepoRef = {
  owner: "cloudflare",
  name: "workerd",
  fullName: "cloudflare/workerd",
  url: "https://github.com/cloudflare/workerd",
};

function pullSummary(id: number, headSha: string, baseSha: string): GitHubPullRequestSummary {
  return {
    repo: REPO,
    id: String(id),
    url: `${REPO.url}/pull/${id}`,
    title: `PR ${id}`,
    state: "open",
    labels: [],
    author: null,
    assignees: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    commentCount: 0,
    draft: false,
    merged: false,
    head: { ref: "feature", sha: headSha, repo: REPO },
    base: { ref: "main", sha: baseSha, repo: REPO },
  };
}

function commitSummary(id: string, parents: string[]): GitHubCommitSummary {
  return {
    id,
    message: `commit ${id.slice(0, 7)}`,
    author: {},
    committer: {},
    authorAccount: null,
    parents,
    url: `${REPO.url}/commit/${id}`,
  };
}

/** The session only calls what the test drives, so each test supplies just those methods. */
function fakeGatekeeper(methods: Partial<Record<string, unknown>>): GitHubGatekeeperImpl {
  return methods as unknown as GitHubGatekeeperImpl;
}

function repoSession(queue: TestApprovalQueue, methods: Partial<Record<string, unknown>>) {
  return new GitHubRepoSessionImpl(fakeGatekeeper(methods), queueStub(queue));
}

function pullSession(queue: TestApprovalQueue, id: string, methods: Partial<Record<string, unknown>>) {
  return new GitHubPullRequestImpl(fakeGatekeeper(methods), queueStub(queue), id);
}

describe("GitHubRepoSessionImpl advertising", () => {
  it("advertises head and base shas per fetched page of listPullRequests", async () => {
    const queue = new TestApprovalQueue();
    const session = repoSession(queue, {
      listPullRequests: async () => pagesCursor([
        [pullSummary(1, oid(1), oid(2))],
        [pullSummary(2, oid(3), oid(2))],
      ]),
    });

    const cursor = await session.listPullRequests();
    expect(await cursor.next()).toHaveLength(1);
    // Only the first page's shas: the second page hasn't been fetched.
    expect(queue.cache.advertised.toSorted()).toEqual([oid(1), oid(2)]);

    expect(await cursor.next()).toHaveLength(1);
    expect(queue.cache.advertised.toSorted()).toEqual([oid(1), oid(2), oid(3)]);
    expect(queue.observations).toEqual(["List pull requests"]);
  });

  it("advertises head and base shas from searchPullRequests, skipping empty provisional shas", async () => {
    const queue = new TestApprovalQueue();
    const session = repoSession(queue, {
      searchPullRequests: async () => pagesCursor([
        [pullSummary(1, oid(1), oid(2)), pullSummary(2, "", "")],
      ]),
    });

    const cursor = await session.searchPullRequests({ text: "frobnicate" });
    expect(await cursor.next()).toHaveLength(2);
    expect(queue.cache.advertised.toSorted()).toEqual([oid(1), oid(2)]);
  });

  it("advertises branch heads from listBranches", async () => {
    const queue = new TestApprovalQueue();
    const session = repoSession(queue, {
      listBranches: async () => pagesCursor([
        [{ name: "main", headCommit: oid(1), protected: true }],
      ]),
    });

    const cursor = await session.listBranches();
    await cursor.next();
    expect(queue.cache.advertised).toEqual([oid(1)]);
  });

  it("advertises tag commits from listTags", async () => {
    const queue = new TestApprovalQueue();
    const session = repoSession(queue, {
      listTags: async () => pagesCursor([
        [{ name: "v1.0.0", commit: oid(1) }],
      ]),
    });

    const cursor = await session.listTags();
    await cursor.next();
    expect(queue.cache.advertised).toEqual([oid(1)]);
  });

  it("advertises commit ids and parents from listCommits", async () => {
    const queue = new TestApprovalQueue();
    const session = repoSession(queue, {
      listCommits: async () => pagesCursor([
        [commitSummary(oid(1), [oid(2)])],
      ]),
    });

    const cursor = await session.listCommits();
    await cursor.next();
    expect(queue.cache.advertised.toSorted()).toEqual([oid(1), oid(2)]);
  });

  it("advertises the resolved commit and its parents from getCommit", async () => {
    const queue = new TestApprovalQueue();
    const session = repoSession(queue, {
      getCommit: async () => commitSummary(oid(1), [oid(2), oid(3)]),
    });

    const details = await session.getCommit("abc1234");
    expect(details.id).toBe(oid(1));
    expect(queue.cache.advertised.toSorted()).toEqual([oid(1), oid(2), oid(3)]);
  });
});

describe("GitHubPullRequestImpl advertising", () => {
  it("advertises the head and base shas returned by getDetails", async () => {
    const queue = new TestApprovalQueue();
    const session = pullSession(queue, "1", {
      openPullRequest: async () => ({
        ...pullSummary(1, oid(1), oid(2)),
        bodyMarkdown: "",
        requestedReviewers: [],
        commits: 1,
        additions: 0,
        deletions: 0,
        changedFiles: 0,
      }),
    });

    await session.getDetails();
    expect(queue.cache.advertised.toSorted()).toEqual([oid(1), oid(2)]);
  });

  it("advertises the revision shas returned by readDiff", async () => {
    const queue = new TestApprovalQueue();
    const session = pullSession(queue, "1", {
      pullDiff: async () => ({
        revision: { baseSha: oid(1), headSha: oid(2) },
        files: pagesCursor([]),
      }),
    });

    await session.readDiff();
    expect(queue.cache.advertised.toSorted()).toEqual([oid(1), oid(2)]);
  });

  it("advertises commit ids and parents per fetched page of listCommits", async () => {
    const queue = new TestApprovalQueue();
    const session = pullSession(queue, "1", {
      pullCommits: async () => pagesCursor([
        [commitSummary(oid(1), [oid(2)])],
        [commitSummary(oid(3), [])],
      ]),
    });

    const cursor = await session.listCommits();
    await cursor.next();
    expect(queue.cache.advertised.toSorted()).toEqual([oid(1), oid(2)]);
    await cursor.next();
    expect(queue.cache.advertised.toSorted()).toEqual([oid(1), oid(2), oid(3)]);
  });
});
