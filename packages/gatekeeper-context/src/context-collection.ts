// One collection's metadata and documents. Metadata changes update the private owner library or the
// public domain registry.

import { DurableObject } from "cloudflare:workers";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import {
  ContextCollectionMetadata, ContextCollectionVisibility,
  ContextDocument, ContextDocumentSummary, DEFAULT_DOCUMENT_CONTENT_TYPE, MAX_DOCUMENT_BODY_BYTES,
  contentTypeFromPath, isTextContentType,
} from "./context-types.js";
import { metadataToSummary } from "./collection-kv.js";
import { domainName } from "./domain.js";

const MAX_DOCUMENT_PATH_LENGTH = 1024;

// Validate a document path before using it as a storage key.
function validateDocumentPath(path: string): void {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("Document path is required.");
  }
  if (path.length > MAX_DOCUMENT_PATH_LENGTH) {
    throw new Error(`Document path is too long (max ${MAX_DOCUMENT_PATH_LENGTH} characters).`);
  }
  if (path.startsWith("/")) {
    throw new Error("Document path must be relative (no leading '/').");
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error("Document path must not contain control characters.");
  }
  for (let segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error("Document path must not contain empty, '.', or '..' segments.");
    }
  }
}

// Last path segment; document names derive from paths.
function baseName(path: string): string {
  let i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

// Lowercased file extension (without the dot), or "" if none.
function extOf(path: string): string {
  let b = baseName(path);
  let i = b.lastIndexOf(".");
  return i <= 0 ? "" : b.slice(i + 1).toLowerCase();
}

type ContextRecord = {
  path: string;
  name: string;
  description: string;
  contentType: string;
  body: string;
  lastUpdated: Date;
};

function makeContextCollectionStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      documents: collection<ContextRecord>()({ primaryKey: "path" }),
    },
    singletons: {
      // Sharing domain for cross-DO references.
      sharingDomain: "",
      // Private owner account id; empty for public collections.
      ownerAccountId: "",
      metadata: <ContextCollectionMetadata>{
        id: "",
        title: "",
        description: "",
        visibility: "private" as ContextCollectionVisibility,
        created: new Date(0),
        lastUpdated: new Date(0),
        documentCount: 0,
      },
    },
  });
}

type ContextCollectionStorage = ReturnType<typeof makeContextCollectionStorage>;

export class ContextCollectionDurableObject extends DurableObject<Cloudflare.Env> {
  private storage: ContextCollectionStorage;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.storage = makeContextCollectionStorage(ctx.storage);
  }

  // Sharing domain for all cross-DO/KV references.
  #domain(): string {
    return this.storage.sharingDomain.get();
  }

  // The owner's UserLibraryDurableObject (private collections only), within this collection's domain.
  #ownerLibrary() {
    let ns = this.ctx.exports.UserLibraryDurableObject;
    return ns.get(ns.idFromName(domainName(this.#domain(), this.storage.ownerAccountId.get())));
  }

  #registry() {
    let ns = this.ctx.exports.LibraryRegistryDurableObject;
    return ns.getByName(this.#domain());
  }

  // Initialize a new collection. Private collections pass an owner; public collections pass "".
  // Rejects re-initialization so a (vanishingly unlikely) id reuse can't clobber existing content.
  initialize(metadata: ContextCollectionMetadata, sharingDomain: string, ownerAccountId: string): void {
    if (this.storage.metadata.get().id) {
      throw new Error("Collection already exists.");
    }
    this.storage.sharingDomain.put(sharingDomain);
    this.storage.ownerAccountId.put(ownerAccountId);
    this.storage.metadata.put(metadata);
  }

  getMetadata(): ContextCollectionMetadata {
    return this.storage.metadata.get();
  }

  async updateMetadata(options: {
    title?: string;
    description?: string;
    icon?: string;
  }): Promise<void> {
    let meta = this.storage.metadata.get();
    let changed = false;

    if (options.title !== undefined && options.title !== meta.title) { meta.title = options.title; changed = true; }
    if (options.description !== undefined && options.description !== meta.description) { meta.description = options.description; changed = true; }
    if (options.icon !== undefined && options.icon !== meta.icon) { meta.icon = options.icon; changed = true; }

    if (changed) {
      meta.lastUpdated = new Date();
      this.storage.metadata.put(meta);
      await this.#propagate();
    }
  }

  // --- Document CRUD ---

  listContextDocuments(prefix?: string): ContextDocumentSummary[] {
    let options = prefix ? { prefix } : undefined;
    let result: ContextDocumentSummary[] = [];
    for (let record of this.storage.documents.list(options)) {
      result.push({
        path: record.path,
        name: record.name,
        description: record.description,
        contentType: record.contentType ?? DEFAULT_DOCUMENT_CONTENT_TYPE,
        lastUpdated: record.lastUpdated,
      });
    }
    return result;
  }

  // Lenient read: bad/missing paths return null, not RPC errors. Mutations validate paths.
  getContextDocument(path: string): ContextDocument | null {
    let record = this.storage.documents.get(path);
    if (!record) return null;
    return {
      path: record.path,
      name: record.name,
      description: record.description,
      contentType: record.contentType ?? DEFAULT_DOCUMENT_CONTENT_TYPE,
      body: record.body,
      lastUpdated: record.lastUpdated,
    };
  }

  async putContextDocument(
      path: string,
      doc: { description: string; body: string; contentType?: string }): Promise<void> {
    validateDocumentPath(path);
    // Enforce real UTF-8 bytes, not UTF-16 code units.
    let byteLength = new TextEncoder().encode(doc.body).length;
    if (byteLength > MAX_DOCUMENT_BODY_BYTES) {
      throw new Error(`Document is too large (${byteLength} bytes; max ${MAX_DOCUMENT_BODY_BYTES}).`);
    }

    let contentType = doc.contentType || contentTypeFromPath(path);
    let isNew = !this.storage.documents.get(path);

    // The display name is always the file name (derived from the path) — a single source of truth.
    this.storage.documents.put({
      path, name: baseName(path), description: doc.description, contentType, body: doc.body, lastUpdated: new Date(),
    });

    let meta = this.storage.metadata.get();
    if (isNew) meta.documentCount++;
    meta.lastUpdated = new Date();
    this.storage.metadata.put(meta);
    await this.#propagate();
  }

  async deleteContextDocument(path: string): Promise<void> {
    // Mutations reject invalid paths; reads stay lenient.
    validateDocumentPath(path);
    let existing = this.storage.documents.get(path);
    if (!existing) throw new Error(`Document not found: ${path}`);

    this.storage.documents.delete(path);

    let meta = this.storage.metadata.get();
    meta.documentCount = Math.max(0, meta.documentCount - 1);
    meta.lastUpdated = new Date();
    this.storage.metadata.put(meta);
    await this.#propagate();
  }

  async moveContextDocument(from: string, to: string): Promise<void> {
    validateDocumentPath(from);
    validateDocumentPath(to);
    if (from === to) return;

    // Reject moving a folder into one of its own descendants.
    if (to.startsWith(from + "/")) {
      throw new Error("Cannot move a folder into itself.");
    }

    let moves: { record: ContextRecord; newPath: string }[] = [];
    let exact = this.storage.documents.get(from);
    if (exact) {
      moves.push({ record: exact, newPath: to });
    } else {
      let fromPrefix = from.endsWith("/") ? from : from + "/";
      let toPrefix = to.endsWith("/") ? to : to + "/";
      for (let record of this.storage.documents.list({ prefix: fromPrefix })) {
        moves.push({ record, newPath: toPrefix + record.path.slice(fromPrefix.length) });
      }
    }

    if (moves.length === 0) throw new Error(`Nothing to move at: ${from}`);

    let movedFrom = new Set(moves.map(m => m.record.path));
    for (let m of moves) {
      if (!movedFrom.has(m.newPath) && this.storage.documents.get(m.newPath)) {
        throw new Error(`Destination already exists: ${m.newPath}`);
      }
    }

    for (let m of moves) this.storage.documents.delete(m.record.path);
    for (let m of moves) {
      // Name follows the new path. Reclassify content type only when the extension changes.
      let contentType = extOf(m.record.path) !== extOf(m.newPath)
        ? contentTypeFromPath(m.newPath)
        : m.record.contentType;
      this.storage.documents.put({
        ...m.record, path: m.newPath, name: baseName(m.newPath), contentType, lastUpdated: new Date(),
      });
    }

    let meta = this.storage.metadata.get();
    meta.lastUpdated = new Date();
    this.storage.metadata.put(meta);
    await this.#propagate();
  }

  // --- Search ---

  // Linear scan over one collection. Replace with an index if collection size makes it matter.
  search(query: string, limit: number = 20): { path: string; name: string; description: string; snippet?: string; score: number }[] {
    let tokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
    if (tokens.length === 0) return [];

    let results: { path: string; name: string; description: string; snippet?: string; score: number }[] = [];

    for (let record of this.storage.documents.list()) {
      let score = 0;
      let snippet: string | undefined;

      let isText = isTextContentType(record.contentType ?? DEFAULT_DOCUMENT_CONTENT_TYPE);
      let nameLower = record.name.toLowerCase();
      let descLower = record.description.toLowerCase();
      let bodyLower = isText ? record.body.toLowerCase() : "";

      for (let token of tokens) {
        if (nameLower.includes(token)) score += 10;
        if (descLower.includes(token)) score += 5;
        let bodyIdx = isText ? bodyLower.indexOf(token) : -1;
        if (bodyIdx >= 0) {
          score += 1;
          if (!snippet) {
            let start = Math.max(0, bodyIdx - 40);
            let end = Math.min(record.body.length, bodyIdx + token.length + 80);
            snippet = (start > 0 ? "..." : "") + record.body.slice(start, end) + (end < record.body.length ? "..." : "");
          }
        }
      }

      if (score > 0) {
        results.push({ path: record.path, name: record.name, description: record.description, snippet, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  // --- Deletion ---

  async deleteSelf(): Promise<void> {
    let meta = this.storage.metadata.get();
    let id = meta.id;

    if (id) {
      if (meta.visibility === "public") {
        await this.#registry().removePublic(this.#domain(), id);
      } else {
        await this.#ownerLibrary().removeOwnedCollection(id);
      }
    }

    await this.ctx.storage.deleteAll();
  }

  // Account revocation clears the whole user-library index separately; don't update it per item.
  async deleteForRevokedOwner(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  // --- Propagation ---

  // Refresh this collection's denormalized summary in its index.
  async #propagate(): Promise<void> {
    let meta = this.storage.metadata.get();
    let summary = metadataToSummary(meta);

    if (meta.visibility === "public") {
      await this.#registry().syncPublic(this.#domain(), summary);
    } else {
      await this.#ownerLibrary().updateOwnedCollection(meta.id, summary);
    }
  }
}
