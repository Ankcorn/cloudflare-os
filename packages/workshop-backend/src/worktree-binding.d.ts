// This file declares the type of a worktree binding -- a binding that basically provides access
// to a file tree, with git integration. An agent can create a worktree binding from a git commit,
// then use its regular file-edit tooling to read and write the files in the worktree. It can also
// access the worktree programmatically in `executeCode` tool calls, where the binding has the API
// defined below.
//
// Agents can create a worktree using the `createWorktree` tool call, similar to `createGadget`
// but takes a commit ID. The commit ID can be obtained from various gatekeeper APIs, e.g. the
// GitHub gatekeeper. Commits created on a worktree can then be pushed back to the gatekeeper.
//
// The agent's `describeBinding` tool serves the agent-facing section of this file as text
// (worktree-binding.txt is a symlink to this file, shipped as a Text module -- the
// agent-spawner-binding.txt pattern), so everything below the marker is written for the agent
// as its audience.

// Everything below the following line is returned to agents via `describeBinding`.
// ---- BEGIN AGENT API ----

/**
 * A worktree binding represents a file tree based on a git commit. You can read and edit files
 * in a worktree using the same tools used to operate on gadget code, targeting the worktree
 * binding instead of a gadget binding. You should prefer those tools when they work. Only use this
 * API when you want to operate on the files more programmatically, or to perform operations other
 * than basic reads and edits.
 */
export interface Worktree {
  // ---------------------------------------------------------------------------
  // File operations

  /**
   * List the entries of the directory at `path` (the worktree root when omitted), or all of its
   * descendants with `recursive: true`. Every returned path is a full path from the worktree
   * root, suitable for passing back to the other file operations.
   *
   * Entries carry no sizes: git tree entries don't record them, and a worktree fetches file
   * content lazily, so reporting sizes would force downloading every file.
   */
  listFiles(path?: string, options?: {recursive?: boolean}): Promise<WorktreeFileEntry[]>;

  /**
   * Read a file as text. Throws if the path doesn't name a regular file: for a symlink the error
   * names the link target, for a submodule (gitlink) it names the pinned commit, and binary or
   * very large (over ~1MB) files report that they cannot be read as text.
   */
  readFile(path: string): Promise<string>;

  /**
   * Write a file's entire content, creating it if absent. Regular files only: writing over a
   * symlink, submodule, or directory throws the same descriptive errors reading one does. An
   * edited executable file keeps its executable bit; newly created files are regular
   * non-executable files. Writes are proposed changes like the file tools' -- they become
   * permanent when the user accepts the conversation's changes.
   */
  writeFile(path: string, text: string): Promise<void>;

  /**
   * Delete a file. Regular files only (symlinks and submodules throw; directories cannot be
   * deleted explicitly -- git has no empty directories, so deleting a directory's last file
   * prunes the directory from the next commit).
   */
  deleteFile(path: string): Promise<void>;

  /**
   * Search the given file (or recursively search the given directory) for all lines matching the
   * given regular expression.
   *
   * Returns results in the format `grep -n` would return, i.e. a string where each line is
   * "<line number>:<line content>", or if `path` refers to a directory,
   * "<file path>:<line number>:<line content>". This format is useful if you just intend to
   * console.log() it. If you intend to operate on the result programmatically, consider using
   * `structuredGrep()` instead.
   *
   * When searching a directory, files that cannot be searched -- binary or over-limit files,
   * symlinks, and submodules -- are skipped, with a note appended to the output for each.
   */
  grep(path: string, pattern: RegExp): Promise<string>;

  /**
   * Like grep but returns a structured format useful for analyzing in code. Unsearchable files
   * (binary/over-limit files, symlinks, submodules) are silently skipped here; use `grep()` or
   * `listFiles()` if you need to see them.
   */
  structuredGrep(path: string, pattern: RegExp): Promise<GrepMatch[]>;

  // ---------------------------------------------------------------------------
  // Git operations

  /**
   * Commit the contents of the worktree to git, returning the new commit ID, and updating the
   * head commit to point at it.
   *
   * There is no separate staging. All changes you have made in this worktree will be included in
   * the git commit.
   */
  commit(message: string): Promise<string>;

  /**
   * Diff the worktree content against the given commit (defaults to the current head commit --
   * the last commit() made here, initially the commit the worktree was created from). `commitId`
   * may be any commit known to the workspace, e.g. the worktree's base commit to see everything
   * changed since it was created.
   *
   * Returns the diff in a format similar to `git diff`; an empty string means no differences.
   * Paths that cannot be rendered as text (binary/over-limit files, symlinks, submodules)
   * contribute a note instead of a diff.
   */
  diff(commitId?: string): Promise<string>;

  // TODO(someday):
  // - merge?
  // - soft reset? (hard reset is better-accomplished by creating a new worktree)
}

/** One entry of a `listFiles()` result. */
export type WorktreeFileEntry = {
  /** Full path from the worktree root. */
  path: string;

  /**
   * What the entry is. "file" and "executable" are regular files -- readable and editable, and an
   * edited executable keeps its executable bit. "dir" is a directory. "symlink" and "submodule"
   * entries are inert: file operations on them throw a descriptive error (naming the symlink's
   * target or the submodule's pinned commit), and searches skip them.
   */
  kind: "file" | "executable" | "dir" | "symlink" | "submodule";
};

/** One match returned by `structuredGrep()`. */
export type GrepMatch = {
  /** Full path of the file containing a match. */
  file: string;

  /** Text line number (1 based) of the match. */
  line: number;

  /** Contents of the line that matched. */
  text: string;
};
