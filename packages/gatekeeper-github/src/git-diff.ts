// Pure helpers for simulating pull request diffs from raw git objects. When a pull request's head
// branch has queued pushes, GitHub cannot compute the diff (the pushed commits are not on the
// remote yet), so the gatekeeper computes it locally: a pruning tree-to-tree walk enumerates the
// changed paths, and a line-level Myers diff produces hunks in the same shape GitHub's own
// patches are parsed into (`parsePatch` in github.ts).
//
// This module deliberately has no runtime imports (in particular no `cloudflare:workers`), so its
// logic runs under the package's Node vitest project. All object reads go through an injected
// `TreeDiffSource`, so the callers decide where bytes come from (the workspace git cache, with
// GitHub's git-data REST API as fallback for the on-remote side).

import type { GitOid } from "@gadgets/workshop-shared/gatekeeper";
import type {
  GitHubPullRequestDiffFile,
  GitHubPullRequestDiffHunk,
  GitHubPullRequestDiffLine,
} from "./types";

/** One entry of a git tree object: mode as written (e.g. `"100644"`, `"40000"`), name, and oid. */
export type GitTreeEntry = {
  mode: string;
  name: string;
  oid: GitOid;
};

/**
 * Where the tree diff reads objects from.
 *
 * `getTree` returns null when the tree object cannot be obtained at all -- the walk then throws
 * `TreeUnavailableError`, and the caller degrades (an enumerable-but-wrong diff would be worse
 * than none). `getBlob` returns `"unavailable"` for a blob that cannot or should not be loaded
 * (missing, or over the size cap); the affected file is then reported with `diffOmitted: true`
 * rather than failing the whole diff -- the same shape GitHub uses for large and binary files.
 */
export type TreeDiffSource = {
  getTree(oid: GitOid): Promise<GitTreeEntry[] | null>;
  getBlob(oid: GitOid): Promise<Uint8Array | "unavailable">;
};

/** Thrown when a tree object needed to enumerate the diff cannot be obtained. */
export class TreeUnavailableError extends Error {
  constructor(oid: GitOid) {
    super(`git tree ${oid} is not available, so the diff cannot be computed`);
  }
}

/** Per-side line cap beyond which a file's hunks are not computed (reported as omitted). */
export const MAX_DIFF_LINES_PER_FILE = 20000;
/** Per-blob byte cap for diffing (either side); larger files are reported with diffOmitted. */
export const MAX_DIFF_BLOB_BYTES = 1024 * 1024;
/** Total bytes of blob content one tree diff may load; further files are reported as omitted. */
export const MAX_DIFF_TOTAL_BYTES = 20 * 1024 * 1024;
/**
 * Myers edit-distance cap. A middle section whose minimal diff would exceed this many edits is
 * emitted as one whole remove-then-add block instead -- still a correct unified diff, just not a
 * minimal one -- keeping worst-case time and memory bounded.
 */
const MAX_DIFF_EDIT_DISTANCE = 1000;

const FILE_MODE_MASK = 0o170000;
const MODE_DIR = 0o040000;
const MODE_SYMLINK = 0o120000;
const MODE_GITLINK = 0o160000;

/** The structural kind of a tree entry, from its mode. */
export function treeEntryKind(mode: string): "dir" | "symlink" | "gitlink" | "file" {
  switch (parseInt(mode, 8) & FILE_MODE_MASK) {
    case MODE_DIR: return "dir";
    case MODE_SYMLINK: return "symlink";
    case MODE_GITLINK: return "gitlink";
    default: return "file";
  }
}

function hexOid(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Parse a git tree object's payload (as returned by `GitCache.get()` -- no `<type> <size>\0`
 * header): repeated `<mode> <name>\0<20-byte oid>`. Entry names are decoded as strict,
 * byte-exact UTF-8: a name that is not valid UTF-8 fails the parse, and a leading BOM is kept
 * (`ignoreBOM: true`) -- either a lossy decode or BOM stripping could alias two distinct entries.
 */
export function parseGitTreePayload(payload: Uint8Array, oid: GitOid): GitTreeEntry[] {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const entries: GitTreeEntry[] = [];
  let offset = 0;
  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset);
    const nul = space === -1 ? -1 : payload.indexOf(0x00, space + 1);
    if (space === -1 || nul === -1 || nul + 21 > payload.length) {
      throw new Error(`git object ${oid} is not a well-formed tree`);
    }
    let mode: string;
    let name: string;
    try {
      mode = decoder.decode(payload.subarray(offset, space));
      name = decoder.decode(payload.subarray(space + 1, nul));
    } catch {
      throw new Error(`git object ${oid} is not a well-formed tree (non-UTF-8 entry name)`);
    }
    if (!/^[0-7]+$/.test(mode)) {
      throw new Error(`git object ${oid} is not a well-formed tree (bad mode ${JSON.stringify(mode)})`);
    }
    entries.push({ mode, name, oid: hexOid(payload.subarray(nul + 1, nul + 21)) });
    offset = nul + 21;
  }
  return entries;
}

/** One changed path found by the tree walk, before any blob content is considered. */
type ChangedEntry = {
  path: string;
  status: "added" | "modified" | "removed";
  oldEntry?: GitTreeEntry;
  newEntry?: GitTreeEntry;
};

async function loadTree(source: TreeDiffSource, oid: GitOid | null): Promise<GitTreeEntry[]> {
  if (oid === null) return [];
  const entries = await source.getTree(oid);
  if (entries === null) throw new TreeUnavailableError(oid);
  return entries;
}

// Recursive pruning walk: subtrees with equal oids are skipped without loading, so the work is
// bounded by the changed portion of the tree rather than the repository size.
async function walkTreeDiff(
  source: TreeDiffSource,
  oldOid: GitOid | null,
  newOid: GitOid | null,
  prefix: string,
  out: ChangedEntry[],
): Promise<void> {
  if (oldOid === newOid) return;
  const oldEntries = new Map((await loadTree(source, oldOid)).map(entry => [entry.name, entry]));
  const newEntries = new Map((await loadTree(source, newOid)).map(entry => [entry.name, entry]));

  const names = [...new Set([...oldEntries.keys(), ...newEntries.keys()])].toSorted();
  for (const name of names) {
    const oldEntry = oldEntries.get(name);
    const newEntry = newEntries.get(name);
    const path = prefix + name;
    const oldKind = oldEntry ? treeEntryKind(oldEntry.mode) : undefined;
    const newKind = newEntry ? treeEntryKind(newEntry.mode) : undefined;
    if (oldEntry && newEntry && oldEntry.oid === newEntry.oid && oldEntry.mode === newEntry.mode) {
      continue;
    }

    // A directory on either side recurses; a dir-vs-file conflict is a remove plus an add.
    if (oldKind === "dir" || newKind === "dir") {
      await walkTreeDiff(
        source,
        oldKind === "dir" ? oldEntry!.oid : null,
        newKind === "dir" ? newEntry!.oid : null,
        `${path}/`,
        out,
      );
      if (oldEntry && oldKind !== "dir") out.push({ path, status: "removed", oldEntry });
      if (newEntry && newKind !== "dir") out.push({ path, status: "added", newEntry });
      continue;
    }

    if (oldEntry && newEntry) {
      out.push({ path, status: "modified", oldEntry, newEntry });
    } else if (newEntry) {
      out.push({ path, status: "added", newEntry });
    } else if (oldEntry) {
      out.push({ path, status: "removed", oldEntry });
    }
  }
}

/**
 * The paths that differ between two trees (either may be null for an empty side). Used for
 * per-commit path filtering; loads no blob content.
 */
export async function changedPathsBetweenTrees(
  source: TreeDiffSource,
  oldTree: GitOid | null,
  newTree: GitOid | null,
): Promise<string[]> {
  const entries: ChangedEntry[] = [];
  await walkTreeDiff(source, oldTree, newTree, "", entries);
  return [...new Set(entries.map(entry => entry.path))];
}

function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

/**
 * Diff two trees into the same per-file shape GitHub's compare/PR-files responses normalize to.
 * Gitlinks (submodule pointers), binary files, files over `MAX_DIFF_BLOB_BYTES`, and files whose
 * content is unavailable are reported with `diffOmitted: true` and no hunks; renames are not
 * detected (they appear as a remove plus an add, which GitHub's own rename detection will
 * supersede once the work reaches the remote).
 */
export async function diffGitTrees(
  source: TreeDiffSource,
  oldTree: GitOid | null,
  newTree: GitOid | null,
): Promise<GitHubPullRequestDiffFile[]> {
  const entries: ChangedEntry[] = [];
  await walkTreeDiff(source, oldTree, newTree, "", entries);

  const files: GitHubPullRequestDiffFile[] = [];
  let budget = MAX_DIFF_TOTAL_BYTES;
  for (const entry of entries) {
    const omitted: GitHubPullRequestDiffFile = {
      path: entry.path,
      status: entry.status,
      additions: 0,
      deletions: 0,
      diffOmitted: true,
      hunks: [],
    };

    // Submodule pointers have no blob content; a same-oid entry differs only in mode. Both are
    // reported without a patch, like GitHub does.
    const oldKind = entry.oldEntry ? treeEntryKind(entry.oldEntry.mode) : undefined;
    const newKind = entry.newEntry ? treeEntryKind(entry.newEntry.mode) : undefined;
    if (oldKind === "gitlink" || newKind === "gitlink" ||
        (entry.oldEntry && entry.newEntry && entry.oldEntry.oid === entry.newEntry.oid)) {
      files.push(omitted);
      continue;
    }

    const oldContent = entry.oldEntry ? await source.getBlob(entry.oldEntry.oid) : new Uint8Array(0);
    const newContent = entry.newEntry ? await source.getBlob(entry.newEntry.oid) : new Uint8Array(0);
    if (oldContent === "unavailable" || newContent === "unavailable" ||
        oldContent.byteLength > MAX_DIFF_BLOB_BYTES || newContent.byteLength > MAX_DIFF_BLOB_BYTES ||
        oldContent.byteLength + newContent.byteLength > budget ||
        isBinary(oldContent) || isBinary(newContent)) {
      files.push(omitted);
      continue;
    }
    budget -= oldContent.byteLength + newContent.byteLength;

    // Keep a leading BOM (`ignoreBOM: true`) so a BOM-only change still produces a visible diff.
    const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
    const { hunks, additions, deletions } =
      diffTextLines(decoder.decode(oldContent), decoder.decode(newContent));
    files.push({
      path: entry.path,
      status: entry.status,
      additions,
      deletions,
      diffOmitted: false,
      hunks,
    });
  }
  return files;
}

type Edit = {
  kind: "context" | "added" | "removed";
  text: string;
};

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * Unified-diff a file's text at line granularity: hunks with git's default 3 lines of context,
 * in the same shape `parsePatch` produces from GitHub's own patches. Minimality is bounded: a
 * pathological middle section is emitted as one whole remove-then-add block (see
 * `MAX_DIFF_EDIT_DISTANCE`).
 */
export function diffTextLines(oldText: string, newText: string): {
  hunks: GitHubPullRequestDiffHunk[];
  additions: number;
  deletions: number;
} {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  // Trim the common prefix and suffix; Myers runs only on the middle.
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start++;
  }
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  const middleOld = oldLines.slice(start, oldEnd);
  const middleNew = newLines.slice(start, newEnd);
  const middle = myersEditScript(middleOld, middleNew) ?? [
    ...middleOld.map(text => ({ kind: "removed", text } as const)),
    ...middleNew.map(text => ({ kind: "added", text } as const)),
  ];

  const edits: Edit[] = [
    ...oldLines.slice(0, start).map(text => ({ kind: "context", text } as const)),
    ...middle,
    ...oldLines.slice(oldEnd).map(text => ({ kind: "context", text } as const)),
  ];
  return buildHunks(edits);
}

// Myers O((N+M)D) shortest edit script, capped at MAX_DIFF_EDIT_DISTANCE (null when exceeded).
function myersEditScript(a: string[], b: string[]): Edit[] | null {
  if (a.length === 0 && b.length === 0) return [];
  if (a.length === 0) return b.map(text => ({ kind: "added", text }));
  if (b.length === 0) return a.map(text => ({ kind: "removed", text }));
  if (a.length > MAX_DIFF_LINES_PER_FILE || b.length > MAX_DIFF_LINES_PER_FILE) return null;

  const max = Math.min(a.length + b.length, MAX_DIFF_EDIT_DISTANCE);
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
        ? v[offset + k + 1]      // move down (an added line)
        : v[offset + k - 1] + 1; // move right (a removed line)
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= a.length && y >= b.length) {
        return backtrackEditScript(trace, d, a, b, offset);
      }
    }
  }
  return null;
}

function backtrackEditScript(
  trace: Int32Array[], endD: number, a: string[], b: string[], offset: number,
): Edit[] {
  const edits: Edit[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = endD; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      edits.push({ kind: "context", text: a[x - 1] });
      x--;
      y--;
    }
    if (prevK === k + 1) {
      edits.push({ kind: "added", text: b[prevY] });
      y--;
    } else {
      edits.push({ kind: "removed", text: a[prevX] });
      x--;
    }
  }
  while (x > 0 && y > 0) {
    edits.push({ kind: "context", text: a[x - 1] });
    x--;
    y--;
  }
  return edits.toReversed();
}

const HUNK_CONTEXT_LINES = 3;

function buildHunks(edits: Edit[]): {
  hunks: GitHubPullRequestDiffHunk[];
  additions: number;
  deletions: number;
} {
  // Number every line, and remember the old/new position *before* each edit so a pure-insert or
  // pure-delete hunk can state the line it attaches after (git's `-l,0` / `+m,0` convention).
  const numbered: GitHubPullRequestDiffLine[] = [];
  const oldBefore: number[] = [];
  const newBefore: number[] = [];
  let oldLine = 1;
  let newLine = 1;
  let additions = 0;
  let deletions = 0;
  for (const edit of edits) {
    oldBefore.push(oldLine);
    newBefore.push(newLine);
    if (edit.kind === "context") {
      numbered.push({ kind: "context", text: edit.text, oldLineNumber: oldLine++, newLineNumber: newLine++ });
    } else if (edit.kind === "removed") {
      numbered.push({ kind: "removed", text: edit.text, oldLineNumber: oldLine++ });
      deletions++;
    } else {
      numbered.push({ kind: "added", text: edit.text, newLineNumber: newLine++ });
      additions++;
    }
  }

  // Group changed lines into hunks: changes separated by more than 2 * context lines of pure
  // context split into separate hunks, each padded with up to `context` lines on both sides.
  const changeIndices = numbered.flatMap((line, index) => line.kind === "context" ? [] : [index]);
  const hunks: GitHubPullRequestDiffHunk[] = [];
  let groupStart = 0;
  while (groupStart < changeIndices.length) {
    let groupEnd = groupStart;
    while (groupEnd + 1 < changeIndices.length &&
           changeIndices[groupEnd + 1] - changeIndices[groupEnd] - 1 <= 2 * HUNK_CONTEXT_LINES) {
      groupEnd++;
    }

    const sliceStart = Math.max(changeIndices[groupStart] - HUNK_CONTEXT_LINES, 0);
    const sliceEnd = Math.min(changeIndices[groupEnd] + HUNK_CONTEXT_LINES + 1, numbered.length);
    const lines = numbered.slice(sliceStart, sliceEnd);
    const oldCount = lines.filter(line => line.oldLineNumber !== undefined).length;
    const newCount = lines.filter(line => line.newLineNumber !== undefined).length;
    const oldStart = oldCount > 0
      ? lines.find(line => line.oldLineNumber !== undefined)!.oldLineNumber!
      : oldBefore[sliceStart] - 1;
    const newStart = newCount > 0
      ? lines.find(line => line.newLineNumber !== undefined)!.newLineNumber!
      : newBefore[sliceStart] - 1;
    const header = `@@ -${oldStart}${oldCount === 1 ? "" : `,${oldCount}`}` +
      ` +${newStart}${newCount === 1 ? "" : `,${newCount}`} @@`;
    hunks.push({ header, lines });
    groupStart = groupEnd + 1;
  }

  return { hunks, additions, deletions };
}
