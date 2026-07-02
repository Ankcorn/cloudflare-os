// Agent read path over enabled collections. Every returned result is authorized as an observation;
// private collection content sets prohibitAllSharing.

import { RpcStub as NativeRpcStub } from "cloudflare:workers";
import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import {
  ContextSearchResult, ContextListing, ContextListingEntry, ContextReadResult,
  ContextCollectionVisibility, isTextContentType,
} from "./context-types.js";
import type { ContextCollectionDurableObject } from "./context-collection.js";
import type { UserLibraryDurableObject } from "./user-library.js";
import { domainName } from "./domain.js";

// Fanout cap for whole-library search/list.
const MAX_COLLECTION_FANOUT = 8;

@validateRpc()
export class LibraryReadSession extends RpcTarget {
  // Per-session enabled set with visibility. Visibility comes from the source (owned = private,
  // public set = public), so prohibitAllSharing needs no per-collection metadata lookup.
  #enabledPromise?: Promise<Map<string, ContextCollectionVisibility>>;

  constructor(
    private collections: DurableObjectNamespace<ContextCollectionDurableObject>,
    private userLibraries: DurableObjectNamespace<UserLibraryDurableObject>,
    private domain: string,
    private accountId: string,
    private approvalQueue: NativeRpcStub<ApprovalQueue>,
  ) {
    super();
  }

  // Release the dup'd approval queue when the read session is disposed.
  [Symbol.dispose](): void {
    this.approvalQueue[Symbol.dispose]?.();
  }

  #collection(id: string): DurableObjectStub<ContextCollectionDurableObject> {
    return this.collections.get(this.collections.idFromName(domainName(this.domain, id)));
  }

  #userLib(): DurableObjectStub<UserLibraryDurableObject> {
    return this.userLibraries.get(this.userLibraries.idFromName(domainName(this.domain, this.accountId)));
  }

  // Computed once per session; search/list/read share it.
  #enabled(): Promise<Map<string, ContextCollectionVisibility>> {
    return (this.#enabledPromise ??= this.#userLib().getEnabledCollections(this.domain));
  }

  // Unknown ids are conservative-private.
  async #anyPrivate(collectionIds: string[]): Promise<boolean> {
    let enabled = await this.#enabled();
    return collectionIds.some(id => (enabled.get(id) ?? "private") === "private");
  }

  async search(query: string, opts?: {
    collectionId?: string;
    limit?: number;
  }): Promise<ContextSearchResult[]> {
    let enabled = await this.#enabled();
    let limit = opts?.limit ?? 20;

    let targetIds: string[];
    if (opts?.collectionId) {
      if (!enabled.has(opts.collectionId)) return [];
      targetIds = [opts.collectionId];
    } else {
      targetIds = [...enabled.keys()];
    }

    let perCollection = await mapWithConcurrency(targetIds, MAX_COLLECTION_FANOUT, async (collectionId) => {
      try {
        let hits = await this.#collection(collectionId).search(query, limit);
        return hits.map((r): ContextSearchResult => ({
          docId: encodeDocId(collectionId, r.path),
          collectionId,
          title: r.name,
          path: r.path,
          description: r.description,
          snippet: r.snippet,
          score: r.score,
        }));
      } catch (err) {
        console.error(`Failed to search collection ${collectionId}:`, err);
        return [];
      }
    });

    let results = perCollection.flat();
    results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    results = results.slice(0, limit);

    // Nothing matched → nothing was observed, so don't record an observation (mirrors read()).
    if (results.length === 0) return results;
    let collectionIds = [...new Set(results.map(r => r.collectionId).filter((id): id is string => !!id))];
    let prohibit = await this.#anyPrivate(collectionIds);
    // Authorize after fetching, before returning data.
    await this.approvalQueue.authorizeObservation({
      title: `Context search: ${query}`,
      description:
        `Searched the Context Library for \`${query}\`. Returned ${results.length} result(s)` +
        (collectionIds.length ? ` across ${collectionIds.length} collection(s).` : "."),
      prohibitAllSharing: prohibit,
    });
    return results;
  }

  async list(opts?: {
    collectionId?: string;
    path?: string;
  }): Promise<ContextListing> {
    let listing = await this.#fetchListing(opts);
    // Nothing listed → nothing was observed, so don't record an observation (mirrors read()).
    if (listing.entries.length === 0) return listing;
    // A collection listing reveals document names/descriptions; top-level collection names don't.
    let prohibit = opts?.collectionId ? await this.#anyPrivate([opts.collectionId]) : false;
    await this.approvalQueue.authorizeObservation({
      title: opts?.collectionId
        ? `Context listing: ${opts.collectionId}${opts.path ? "/" + opts.path : ""}`
        : "Context listing: collections",
      description: opts?.collectionId
        ? `Listed contents of Context Library collection \`${opts.collectionId}\`.`
        : "Listed the user's Context Library collections.",
      prohibitAllSharing: prohibit,
    });
    return listing;
  }

  async read(docId: string): Promise<ContextReadResult | null> {
    let decoded = decodeDocId(docId);
    // Malformed ids are "not found", not RPC errors.
    if (!decoded) return null;
    let { collectionId, path } = decoded;

    let enabled = await this.#enabled();
    if (!enabled.has(collectionId)) return null;

    let doc = await this.#collection(collectionId).getContextDocument(path);
    // No document found (missing or inaccessible) → nothing was observed, so don't record one.
    if (!doc) return null;

    let prohibit = await this.#anyPrivate([collectionId]);
    await this.approvalQueue.authorizeObservation({
      title: `Context read: ${doc.name}`,
      description: `Read Context Library document \`${docId}\`.`,
      prohibitAllSharing: prohibit,
    });

    let content = isTextContentType(doc.contentType)
      ? doc.body
      : `data:${doc.contentType};base64,${doc.body}`;
    return {
      docId,
      title: doc.name,
      path: doc.path,
      description: doc.description,
      content,
    };
  }

  // Fetch without recording; list() authorizes.
  async #fetchListing(opts?: { collectionId?: string; path?: string }): Promise<ContextListing> {
    let enabled = await this.#enabled();

    if (!opts?.collectionId) {
      let collectionEntries = await mapWithConcurrency([...enabled.keys()], MAX_COLLECTION_FANOUT,
        async (collectionId): Promise<ContextListingEntry | null> => {
          try {
            let meta = await this.#collection(collectionId).getMetadata();
            return {
              type: "collection",
              id: collectionId,
              title: meta.title,
              description: meta.description,
              documentCount: meta.documentCount,
            };
          } catch (err) {
            console.error(`Failed to list collection ${collectionId}:`, err);
            return null;
          }
        });
      return { entries: collectionEntries.filter((e): e is ContextListingEntry => e !== null) };
    }

    if (!enabled.has(opts.collectionId)) {
      return { collectionId: opts.collectionId, entries: [] };
    }

    let pathPrefix = opts.path ? opts.path + "/" : "";
    let docs = await this.#collection(opts.collectionId).listContextDocuments(pathPrefix || undefined);

    let entries: ContextListingEntry[] = [];
    let seenDirs = new Set<string>();
    for (let doc of docs) {
      let relativePath = doc.path.slice(pathPrefix.length);
      let slashIdx = relativePath.indexOf("/");
      if (slashIdx >= 0) {
        let dirName = relativePath.slice(0, slashIdx);
        let dirPath = pathPrefix + dirName;
        if (!seenDirs.has(dirPath)) {
          seenDirs.add(dirPath);
          entries.push({ type: "directory", path: dirPath, name: dirName });
        }
      } else {
        entries.push({
          type: "document",
          docId: encodeDocId(opts.collectionId, doc.path),
          path: doc.path,
          name: doc.name,
          description: doc.description,
          contentType: doc.contentType,
        });
      }
    }

    return { collectionId: opts.collectionId, path: opts.path, entries };
  }
}

async function mapWithConcurrency<T, R>(
    items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  let results: R[] = Array.from({ length: items.length });
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      let i = next++;
      results[i] = await fn(items[i]);
    }
  }
  let workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function encodeDocId(collectionId: string, path: string): string {
  return `${collectionId}/${path}`;
}

// Split opaque "collectionId/path" ids; malformed means not found.
function decodeDocId(docId: string): { collectionId: string; path: string } | null {
  let slashIdx = docId.indexOf("/");
  if (slashIdx < 0) return null;
  let collectionId = docId.slice(0, slashIdx);
  let path = docId.slice(slashIdx + 1);
  if (!collectionId || !path) return null;
  return { collectionId, path };
}
