import { Button, Dialog, Input, useKumoToastManager } from "@cloudflare/kumo";
import {
  BookOpen,
  Folder,
  FolderOpen,
  FileText,
  Plus,
  Trash,
  PencilSimple,
  MagnifyingGlass,
  CaretRight,
  CaretDown,
  GlobeSimple,
  Lock,
  Gear,
  Image as ImageIcon,
  UploadSimple,
  FilePlus,
  FolderPlus,
  FloppyDisk,
  Code,
  Article,
} from "@phosphor-icons/react";
import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import type {
  ContextCollectionMetadata,
  ContextCollectionVisibility,
  ContextDocumentSummary,
  EnabledCollectionInfo,
} from "../src/context-types";
import {
  contentTypeFromPath,
  isImageContentType,
  isTextContentType,
} from "../src/context-types";
import emojiData from "@emoji-mart/data";
import { Picker as EmojiMartPicker } from "emoji-mart";
import {
  MDXEditor,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  markdownShortcutPlugin,
  linkPlugin,
  linkDialogPlugin,
  imagePlugin,
  tablePlugin,
  codeBlockPlugin,
  codeMirrorPlugin,
  toolbarPlugin,
  UndoRedo,
  BoldItalicUnderlineToggles,
  BlockTypeSelect,
  ListsToggle,
  CreateLink,
  InsertImage,
  InsertTable,
  InsertThematicBreak,
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";
import { useContextApi } from "./bridge";
import { extractDescription, splitFrontmatter, joinFrontmatter } from "./description-extractors";

// Last path segment (file or folder name).
function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

// Parent directory of a path ("" for root).
function dirName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

// Resolve a markdown-relative path within a collection; strip query/fragment.
function resolveCollectionPath(baseDir: string, rel: string): string {
  rel = rel.split(/[?#]/)[0];
  const segs = rel.startsWith("/") ? [] : baseDir ? baseDir.split("/") : [];
  for (const part of rel.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segs.pop();
    else segs.push(part);
  }
  return segs.join("/");
}

// External/absolute image refs are left untouched.
function isExternalImageSrc(src: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(src) || // scheme: http:, https:, data:, blob:, etc.
    src.startsWith("//") ||
    src.startsWith("#")
  );
}

// Bounded-concurrency helper for bulk RPC operations.
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      await fn(items[next++]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
}

// Segment-aware path-prefix replacement.
function replacePathPrefix(path: string, fromPrefix: string, toPrefix: string): string {
  if (path === fromPrefix) return toPrefix;
  if (path.startsWith(fromPrefix + "/")) return toPrefix + path.slice(fromPrefix.length);
  return path;
}

// Rich editor failures fall back to source editing.
class EditorErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

// Read a File as base64 (no data: prefix) for binary uploads.
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = reader.result as string;
      // result is "data:<mime>;base64,<data>"; strip the prefix.
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    });
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

function dataUri(contentType: string, base64Body: string): string {
  return `data:${contentType};base64,${base64Body}`;
}

const DEFAULT_COLLECTION_ICON = "📚";

// A button showing the current emoji that opens a popover emoji picker.
function IconPickerButton({
  value,
  onChange,
  size = 32,
}: {
  value?: string;
  onChange: (emoji: string) => void;
  size?: number;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pickerHostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  useEffect(() => {
    if (!open || !pickerHostRef.current) return;
    const host = pickerHostRef.current;
    const picker = new (EmojiMartPicker as any)({
      data: emojiData,
      theme: window.matchMedia?.("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light",
      previewPosition: "none",
      skinTonePosition: "none",
      // Hide the "Frequently used" category.
      maxFrequentRows: 0,
      onEmojiSelect: (e: { native: string }) => {
        onChange(e.native);
        setOpen(false);
      },
    });
    host.appendChild(picker as unknown as Node);
    return () => {
      host.replaceChildren();
    };
  }, [open, onChange]);

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Choose an icon"
        className="grid place-items-center rounded-xl border border-kumo-line bg-kumo-base hover:border-kumo-brand transition-colors"
        style={{
          width: size + 12,
          height: size + 12,
          fontSize: size * 0.66,
          lineHeight: 1,
        }}
      >
        <span>{value || DEFAULT_COLLECTION_ICON}</span>
      </button>
      {open && (
        <div ref={pickerHostRef} className="absolute z-[1100] mt-1 left-0" />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout primitives (matching Gatekeepers page)
// ---------------------------------------------------------------------------

function SectionEyebrow({ label, count }: { label: string; count?: number }) {
  return (
    <div className="mb-3.5 flex items-center gap-3 px-1">
      <h2 className="m-0 text-[11px] leading-4 font-semibold uppercase tracking-[0.9px] text-kumo-subtle">
        {label}
      </h2>
      <div className="h-px flex-1 bg-kumo-line" />
      {typeof count === "number" && (
        <span className="text-[11px] leading-4 font-semibold tracking-[-0.1px] text-kumo-inactive">
          {count}
        </span>
      )}
    </div>
  );
}

function CollectionCard({
  title,
  icon,
  metaLine,
  tagline,
  badge,
  trailing,
  onClick,
}: {
  title: string;
  icon?: string;
  metaLine?: React.ReactNode;
  tagline?: string;
  badge?: { label: string; tone: "private" | "public" };
  // Extra content shown on the right, before the caret.
  trailing?: React.ReactNode;
  // Clicking any card opens the collection (read-only or editable depending on the user's access).
  onClick: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.currentTarget !== e.target) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className="group grid w-full cursor-pointer grid-cols-[36px_1fr_auto] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-kumo-tint"
    >
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-kumo-tint group-hover:bg-kumo-base">
        {icon ? (
          <span className="text-[20px] leading-none">{icon}</span>
        ) : (
          <BookOpen size={18} weight="duotone" className="text-kumo-brand" />
        )}
      </div>

      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-[14px] leading-5 font-medium tracking-[-0.25px] text-kumo-default">
            {title}
          </span>
          {badge && (
            <span
              className={`flex-shrink-0 rounded-full px-1.5 py-0.5 text-[10px] leading-3 font-semibold uppercase tracking-[0.4px] ${
                badge.tone === "public"
                  ? "bg-green-500/10 text-green-600 dark:text-green-400"
                  : "bg-kumo-tint text-kumo-subtle"
              }`}
            >
              {badge.label}
            </span>
          )}
        </div>
        {(tagline || metaLine) && (
          <div className="mt-0.5 flex items-center gap-1.5 truncate text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
            {tagline ? <span className="truncate">{tagline}</span> : metaLine}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        {trailing}
        <div className="grid h-7 w-7 place-items-center text-kumo-inactive transition-colors group-hover:text-kumo-default">
          <CaretRight size={14} weight="bold" />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// New collection modal
// ---------------------------------------------------------------------------

function NewCollectionModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const context = useContextApi();
  const toasts = useKumoToastManager();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<ContextCollectionVisibility>("private");
  const [icon, setIcon] = useState(DEFAULT_COLLECTION_ICON);
  const [creating, setCreating] = useState(false);
  // Only admins may create public collections.
  const [isAdmin, setIsAdmin] = useState(false);

  // Reset the form each time the modal opens.
  useEffect(() => {
    if (open) {
      setTitle("");
      setDescription("");
      setVisibility("private");
      setIcon(DEFAULT_COLLECTION_ICON);
      setCreating(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    context
      .getViewerInfo()
      .then((info) => {
        if (!cancelled) setIsAdmin(info.isAdmin);
      })
      .catch(() => {
        if (!cancelled) setIsAdmin(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, context]);

  const handleCreate = async () => {
    if (!title.trim()) return;
    setCreating(true);
    try {
      await context.createContextCollection(
        title.trim(),
        description.trim(),
        visibility,
        icon,
      );
      toasts.add({ title: "Collection created", variant: "success" });
      onCreated();
    } catch {
      toasts.add({ title: "Failed to create collection", variant: "error" });
      setCreating(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next: boolean) => {
        if (!next) onClose();
      }}
    >
      <Dialog
        className="!z-[1000] !w-[min(460px,calc(100vw-32px))] overflow-visible bg-kumo-base p-0 !top-[16%] !-translate-y-0"
        size="sm"
      >
        <div className="border-b border-kumo-line px-5 py-4">
          <Dialog.Title className="text-[15px] leading-5 font-medium tracking-[-0.3px] text-kumo-default">
            New collection
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-[13px] leading-[18px] text-kumo-subtle">
            A collection of documents your agents can use.
          </Dialog.Description>
        </div>

        <div className="flex flex-col gap-3 px-5 py-4">
          <div className="flex items-center gap-3">
            <IconPickerButton value={icon} onChange={setIcon} />
            <div className="flex-1">
              <Input
                value={title}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)}
                onKeyDown={(e: React.KeyboardEvent) => {
                  if (e.key === "Enter") handleCreate();
                }}
                placeholder="Title"
                autoFocus
              />
            </div>
          </div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What context this collection provides"
            className="w-full rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default min-h-[72px] resize-y focus:outline-none focus:border-kumo-brand"
          />
          {isAdmin && (
            <div className="flex items-center gap-2">
              <label className="text-sm text-kumo-subtle">Visibility:</label>
              <select
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as ContextCollectionVisibility)}
                className="rounded border border-kumo-line bg-kumo-base px-2 py-1 text-sm text-kumo-default"
              >
                <option value="private">Private — only you</option>
                <option value="public">Public — shared with everyone</option>
              </select>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-kumo-line px-5 py-3">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleCreate} loading={creating} disabled={!title.trim()}>
            Create
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ContextLibraryPage() {
  const context = useContextApi();

  // Iframe-local selection state (no router/URL).
  const [selectedCollection, setSelectedCollection] = useState<string | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null);

  const goToCollection = useCallback((id: string | null) => {
    setSelectedCollection(id);
    setSelectedDoc(null);
  }, []);
  const goToDoc = useCallback((path: string | null) => {
    setSelectedDoc(path);
  }, []);

  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);

  const [enabled, setEnabled] = useState<EnabledCollectionInfo[]>([]);
  const [enabledLoaded, setEnabledLoaded] = useState(false);

  const loadAll = useCallback(async () => {
    const enabledResult = await context
      .listEnabledContextCollections()
      .catch(() => null);
    if (enabledResult) {
      setEnabled(enabledResult);
      setEnabledLoaded(true);
    }
  }, [context]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const searchLower = search.toLowerCase();
  const matchesSearch = useCallback(
    (c: EnabledCollectionInfo) =>
      !searchLower ||
      c.title.toLowerCase().includes(searchLower) ||
      c.description.toLowerCase().includes(searchLower),
    [searchLower],
  );
  const filteredPrivate = useMemo(
    () =>
      enabled
        .filter((c) => c.source === "private" && matchesSearch(c))
        .sort((a, b) => a.title.localeCompare(b.title)),
    [enabled, matchesSearch],
  );
  const filteredPublic = useMemo(
    () =>
      enabled
        .filter((c) => c.source === "public" && matchesSearch(c))
        .sort((a, b) => a.title.localeCompare(b.title)),
    [enabled, matchesSearch],
  );

  const initialLoading = !enabledLoaded && enabled.length === 0;

  // Drill-down into a collection
  if (selectedCollection) {
    return (
      <div className="relative min-h-full bg-kumo-base">
        <div className="relative mx-auto w-full max-w-[1040px] px-4 py-12 sm:px-8 sm:py-14">
          <CollectionEditor
            collectionId={selectedCollection}
            selectedPath={selectedDoc}
            onSelectPath={goToDoc}
            onBack={() => {
              goToCollection(null);
              loadAll();
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-full overflow-hidden bg-kumo-base">
      {/* Dot-grid background */}
      <div
        className="pointer-events-none absolute inset-0 h-[320px]"
        style={{
          backgroundImage:
            "radial-gradient(circle, var(--color-kumo-line) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
          maskImage:
            "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 80%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 80%)",
        }}
      />

      <div className="relative mx-auto w-full max-w-[1040px] px-4 py-12 sm:px-8 sm:py-14">
        {/* Hero header */}
        <header className="mb-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="m-0 text-[32px] leading-[1.05] font-semibold tracking-[-1.2px] text-kumo-default sm:text-[38px]">
                Context
              </h1>
              <p className="mt-3 text-[15px] leading-[22px] font-normal tracking-[-0.25px] text-kumo-subtle">
                Collections of documents, skills, and other files your agents
                can use. Your private collections are yours alone; public
                collections are shared with everyone.
              </p>
            </div>
            <Button
              size="sm"
              onClick={() => setCreating(true)}
              className="shrink-0 mt-2"
            >
              <Plus size={16} className="mr-1" />
              New Collection
            </Button>
          </div>
        </header>

        {/* New collection modal */}
        <NewCollectionModal
          open={creating}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            loadAll();
          }}
        />

        {/* Search */}
        <div className="relative mb-8">
          <MagnifyingGlass
            size={18}
            className="pointer-events-none absolute left-[18px] top-1/2 -translate-y-1/2 text-kumo-subtle"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search collections"
            className="!h-[52px] w-full rounded-[14px] border border-kumo-line bg-kumo-base pl-12 pr-4 text-[15px] leading-5 font-normal tracking-[-0.25px] text-kumo-default placeholder:text-kumo-inactive shadow-none transition-[border-color,box-shadow] focus:border-kumo-ring focus:outline-none focus:ring-[3px] focus:ring-black/5"
          />
        </div>

        {initialLoading && (
          <div className="rounded-2xl border border-kumo-line bg-kumo-base px-4 py-8 text-center text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
            Loading collections...
          </div>
        )}

        {/* The user's own private collections. */}
        {filteredPrivate.length > 0 && (
          <section className="mb-10">
            <SectionEyebrow label="Your collections" count={filteredPrivate.length} />
            <div className="divide-y divide-kumo-line overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
              {filteredPrivate.map((c) => (
                <CollectionCard
                  key={c.id}
                  title={c.title}
                  icon={c.icon}
                  tagline={c.description}
                  onClick={() => goToCollection(c.id)}
                />
              ))}
            </div>
          </section>
        )}

        {/* Public collections, shared with everyone. */}
        {filteredPublic.length > 0 && (
          <section className="mb-10">
            <SectionEyebrow label="Public collections" count={filteredPublic.length} />
            <div className="divide-y divide-kumo-line overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
              {filteredPublic.map((c) => (
                <CollectionCard
                  key={c.id}
                  title={c.title}
                  icon={c.icon}
                  tagline={c.description}
                  badge={{ label: "public", tone: "public" }}
                  onClick={() => goToCollection(c.id)}
                />
              ))}
            </div>
          </section>
        )}

        {!initialLoading &&
          filteredPrivate.length === 0 &&
          filteredPublic.length === 0 && (
            <div className="rounded-2xl border border-kumo-line bg-kumo-base px-4 py-8 text-center">
              <BookOpen size={32} className="mx-auto mb-3 text-kumo-subtle" />
              <p className="m-0 text-[15px] leading-5 font-medium tracking-[-0.25px] text-kumo-default">
                {search ? "No collections match" : "No collections yet"}
              </p>
              <p className="mt-1 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
                {search
                  ? "We couldn't find anything matching your search."
                  : "Create a collection to give your agents context to work with."}
              </p>
            </div>
          )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Collection Header (read-only display + settings gear)
// ---------------------------------------------------------------------------

function CollectionHeader({
  metadata,
  canWrite,
  onOpenSettings,
}: {
  metadata: ContextCollectionMetadata;
  canWrite: boolean;
  onOpenSettings: () => void;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-3">
          {metadata.icon && (
            <span className="text-2xl leading-none flex-shrink-0">
              {metadata.icon}
            </span>
          )}
          <h2 className="text-lg font-semibold text-kumo-strong truncate">
            {metadata.title}
          </h2>
          <span
            className={`flex flex-shrink-0 items-center gap-1 text-xs px-2 py-0.5 rounded ${
              metadata.visibility === "public"
                ? "bg-green-500/10 text-green-600 dark:text-green-400"
                : "bg-kumo-tint text-kumo-subtle"
            }`}
          >
            {metadata.visibility === "public" ? (
              <GlobeSimple size={14} />
            ) : (
              <Lock size={14} />
            )}
            {metadata.visibility}
          </span>
        </div>
        {metadata.description && (
          <p className="text-sm text-kumo-subtle mt-1">
            {metadata.description}
          </p>
        )}
        <div className="flex items-center gap-2 mt-1.5">
          <span className="text-xs text-kumo-subtle">
            {metadata.documentCount} document
            {metadata.documentCount !== 1 ? "s" : ""}
          </span>
        </div>
      </div>
      <div className="flex flex-shrink-0 items-center gap-2">
        {canWrite && (
          <button
            onClick={onOpenSettings}
            className="p-2 text-kumo-subtle hover:text-kumo-default rounded-md hover:bg-kumo-tint transition-colors"
            title="Collection settings"
          >
            <Gear size={18} />
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Collection Settings modal (edit metadata + delete)
// ---------------------------------------------------------------------------

function CollectionSettingsModal({
  open,
  metadata,
  collectionId,
  onClose,
  onUpdated,
  onDeleted,
}: {
  open: boolean;
  metadata: ContextCollectionMetadata;
  collectionId: string;
  onClose: () => void;
  onUpdated: () => void;
  onDeleted: () => void;
}) {
  const context = useContextApi();
  const toasts = useKumoToastManager();

  const [mode, setMode] = useState<"edit" | "delete">("edit");
  const [title, setTitle] = useState(metadata.title);
  const [description, setDescription] = useState(metadata.description);
  const [icon, setIcon] = useState(metadata.icon ?? DEFAULT_COLLECTION_ICON);
  const [confirmText, setConfirmText] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Reset state each time the modal opens, syncing to the latest metadata.
  useEffect(() => {
    if (open) {
      setMode("edit");
      setTitle(metadata.title);
      setDescription(metadata.description);
      setIcon(metadata.icon ?? DEFAULT_COLLECTION_ICON);
      setConfirmText("");
      setSaving(false);
      setDeleting(false);
    }
  }, [open, metadata.title, metadata.description, metadata.icon]);

  const busy = saving || deleting;

  const handleSave = async () => {
    const updates: {
      title?: string;
      description?: string;
      icon?: string;
    } = {};
    if (title.trim() !== metadata.title) updates.title = title.trim();
    if (description.trim() !== metadata.description)
      updates.description = description.trim();
    if (icon !== (metadata.icon ?? DEFAULT_COLLECTION_ICON))
      updates.icon = icon;
    if (Object.keys(updates).length === 0) {
      onClose();
      return;
    }
    if (!title.trim()) {
      toasts.add({ title: "Title can't be empty", variant: "error" });
      return;
    }
    setSaving(true);
    try {
      await context.updateContextCollection(collectionId, updates);
      toasts.add({ title: "Collection updated", variant: "success" });
      onUpdated();
      onClose();
    } catch {
      toasts.add({ title: "Failed to update collection", variant: "error" });
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await context.deleteContextCollection(collectionId);
      toasts.add({ title: "Collection deleted", variant: "success" });
      onDeleted();
    } catch {
      toasts.add({ title: "Failed to delete collection", variant: "error" });
      setDeleting(false);
    }
  };

  const canDelete = confirmText.trim() === metadata.title.trim() && !deleting;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next: boolean) => {
        if (!busy && !next) onClose();
      }}
    >
      <Dialog
        className="!z-[1000] !w-[min(480px,calc(100vw-32px))] overflow-visible bg-kumo-base p-0 !top-[14%] !-translate-y-0"
        size="sm"
      >
        {mode === "edit" ? (
          <>
            <div className="border-b border-kumo-line px-5 py-4">
              <Dialog.Title className="text-[15px] leading-5 font-medium tracking-[-0.3px] text-kumo-default">
                Collection settings
              </Dialog.Title>
            </div>

            <div className="flex flex-col gap-4 px-5 py-4">
              <div>
                <label className="block text-[12px] leading-4 text-kumo-subtle mb-1.5">
                  Icon & title
                </label>
                <div className="flex items-center gap-3">
                  <IconPickerButton value={icon} onChange={setIcon} />
                  <div className="flex-1">
                    <Input
                      value={title}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        setTitle(e.target.value)
                      }
                      placeholder="Collection title"
                      disabled={saving}
                    />
                  </div>
                </div>
              </div>
              <div>
                <label className="block text-[12px] leading-4 text-kumo-subtle mb-1.5">
                  Description
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What context this collection provides"
                  disabled={saving}
                  className="w-full rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default min-h-[72px] resize-y focus:outline-none focus:border-kumo-brand disabled:opacity-50"
                />
              </div>

              <button
                type="button"
                onClick={() => setMode("delete")}
                disabled={saving}
                className="flex items-center gap-1.5 self-start text-[13px] font-medium text-kumo-danger hover:underline disabled:opacity-40"
              >
                <Trash size={15} />
                Delete this collection
              </button>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-kumo-line bg-kumo-base px-5 py-3">
              <Button
                size="sm"
                variant="ghost"
                disabled={saving}
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={handleSave} loading={saving}>
                Save
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="border-b border-kumo-line px-5 py-4">
              <Dialog.Title className="text-[15px] leading-5 font-medium tracking-[-0.3px] text-kumo-default">
                Delete collection
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[13px] leading-[18px] font-normal tracking-[-0.2px] text-kumo-subtle">
                This permanently deletes{" "}
                <span className="font-medium text-kumo-default">
                  {metadata.title}
                </span>{" "}
                and all{" "}
                <span className="font-medium text-kumo-danger">
                  {metadata.documentCount} document
                  {metadata.documentCount !== 1 ? "s" : ""}
                </span>{" "}
                inside it. This cannot be undone.
              </Dialog.Description>
            </div>

            <div className="px-5 py-4">
              <label className="block text-[12px] leading-4 text-kumo-subtle mb-1.5">
                Type{" "}
                <span className="font-mono text-kumo-default">
                  {metadata.title}
                </span>{" "}
                to confirm:
              </label>
              <Input
                value={confirmText}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setConfirmText(e.target.value)
                }
                placeholder={metadata.title}
                disabled={deleting}
                autoFocus
              />
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-kumo-line bg-kumo-base px-5 py-3">
              <Button
                size="sm"
                variant="ghost"
                disabled={deleting}
                onClick={() => setMode("edit")}
              >
                Back
              </Button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={!canDelete}
                className="rounded-md bg-kumo-danger px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {deleting ? "Deleting..." : "Delete collection"}
              </button>
            </div>
          </>
        )}
      </Dialog>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------
// File tree model
// ---------------------------------------------------------------------------

type TreeFolder = {
  name: string;
  path: string; // full path of this folder ("" = root)
  folders: Map<string, TreeFolder>;
  files: ContextDocumentSummary[];
};

function buildTree(
  docs: ContextDocumentSummary[],
  extraFolders: string[],
): TreeFolder {
  const root: TreeFolder = {
    name: "",
    path: "",
    folders: new Map(),
    files: [],
  };
  const ensureFolder = (dir: string): TreeFolder => {
    if (!dir) return root;
    let node = root;
    let acc = "";
    for (const seg of dir.split("/")) {
      acc = acc ? `${acc}/${seg}` : seg;
      if (!node.folders.has(seg)) {
        node.folders.set(seg, {
          name: seg,
          path: acc,
          folders: new Map(),
          files: [],
        });
      }
      node = node.folders.get(seg)!;
    }
    return node;
  };
  for (const f of extraFolders) ensureFolder(f);
  for (const doc of docs) ensureFolder(dirName(doc.path)).files.push(doc);
  return root;
}

// Shared state for the recursive tree renderer.
type TreeCtx = {
  // Hides row actions and drag-to-move when false.
  canWrite: boolean;
  selectedPath: string | null;
  expanded: Set<string>;
  toggleFolder: (path: string) => void;
  selectFile: (path: string) => void;
  creating: { dir: string; kind: "file" | "folder" } | null;
  creatingName: string;
  setCreatingName: (v: string) => void;
  startCreate: (dir: string, kind: "file" | "folder") => void;
  commitCreate: () => void;
  cancelCreate: () => void;
  renaming: string | null;
  renameValue: string;
  setRenameValue: (v: string) => void;
  startRename: (path: string) => void;
  commitRename: () => void;
  cancelRename: () => void;
  deletePath: (path: string, isDir: boolean) => void;
  dragPath: string | null;
  setDragPath: (p: string | null) => void;
  dragOverDir: string | null;
  setDragOverDir: (d: string | null) => void;
  moveTo: (from: string, targetDir: string) => void;
};

function CreateRow({ depth, ctx }: { depth: number; ctx: TreeCtx }) {
  return (
    <div
      className="flex items-center gap-2 px-3 py-1"
      style={{ paddingLeft: `${depth * 18 + 30}px` }}
    >
      {ctx.creating!.kind === "folder" ? (
        <Folder
          size={16}
          weight="fill"
          className="text-kumo-brand flex-shrink-0"
        />
      ) : (
        <FileText size={15} className="text-kumo-subtle flex-shrink-0" />
      )}
      <input
        autoFocus
        value={ctx.creatingName}
        onChange={(e) => ctx.setCreatingName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") ctx.commitCreate();
          else if (e.key === "Escape") ctx.cancelCreate();
        }}
        // Don't commit when focus moves to an action button (new file/folder, rename, delete, …) —
        // let that button's click take effect instead of racing an unintended commit ahead of it.
        onBlur={(e) => {
          if (!(e.relatedTarget instanceof HTMLButtonElement)) ctx.commitCreate();
        }}
        placeholder={
          ctx.creating!.kind === "folder" ? "folder name" : "file-name.md"
        }
        className="flex-1 min-w-0 rounded border border-kumo-brand bg-kumo-base px-1.5 py-0.5 text-sm text-kumo-default focus:outline-none"
      />
    </div>
  );
}

function FolderView({
  folder,
  depth,
  ctx,
}: {
  folder: TreeFolder;
  depth: number;
  ctx: TreeCtx;
}) {
  const sortedFolders = [...folder.folders.values()].toSorted((a, b) =>
    a.name.localeCompare(b.name),
  );
  const sortedFiles = [...folder.files].toSorted((a, b) =>
    a.path.localeCompare(b.path),
  );
  const isRoot = folder.path === "";
  const open = isRoot || ctx.expanded.has(folder.path);
  const isDragOver = ctx.dragOverDir === folder.path;

  const dropHandlers = {
    onDragOver: (e: React.DragEvent) => {
      if (ctx.dragPath) {
        e.preventDefault();
        // dragover fires continuously; only update state when the target dir actually changes,
        // otherwise every tick re-renders the whole tree.
        if (ctx.dragOverDir !== folder.path) ctx.setDragOverDir(folder.path);
      }
    },
    onDragLeave: () => {
      if (ctx.dragOverDir === folder.path) ctx.setDragOverDir(null);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (ctx.dragPath) ctx.moveTo(ctx.dragPath, folder.path);
      ctx.setDragOverDir(null);
      ctx.setDragPath(null);
    },
  };

  return (
    <div>
      {!isRoot && (
        <div
          draggable={ctx.canWrite}
          onDragStart={() => ctx.setDragPath(folder.path)}
          onDragEnd={() => {
            ctx.setDragPath(null);
            ctx.setDragOverDir(null);
          }}
          {...(ctx.canWrite ? dropHandlers : {})}
          className={`group flex items-center gap-1.5 rounded-md pr-2 py-1 transition-colors ${
            isDragOver
              ? "bg-kumo-brand/10 ring-1 ring-kumo-brand/40"
              : "hover:bg-kumo-tint"
          }`}
          style={{ paddingLeft: `${depth * 18 + 8}px` }}
        >
          <button
            onClick={() => ctx.toggleFolder(folder.path)}
            className="flex flex-1 min-w-0 items-center gap-1.5 text-left"
          >
            {open ? (
              <CaretDown size={13} className="text-kumo-subtle flex-shrink-0" />
            ) : (
              <CaretRight
                size={13}
                className="text-kumo-subtle flex-shrink-0"
              />
            )}
            {open ? (
              <FolderOpen
                size={16}
                weight="fill"
                className="text-kumo-brand flex-shrink-0"
              />
            ) : (
              <Folder
                size={16}
                weight="fill"
                className="text-kumo-brand flex-shrink-0"
              />
            )}
            {ctx.renaming === folder.path ? (
              <input
                autoFocus
                value={ctx.renameValue}
                onChange={(e) => ctx.setRenameValue(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") ctx.commitRename();
                  else if (e.key === "Escape") ctx.cancelRename();
                }}
                // Don't commit when focus moves to an action button; let that click win.
                onBlur={(e) => {
                  if (!(e.relatedTarget instanceof HTMLButtonElement)) ctx.commitRename();
                }}
                className="flex-1 min-w-0 rounded border border-kumo-brand bg-kumo-base px-1 py-0 text-sm text-kumo-default focus:outline-none"
              />
            ) : (
              <span className="truncate text-sm font-medium text-kumo-strong">
                {folder.name}
              </span>
            )}
          </button>
          {ctx.canWrite && (
            <div className="flex flex-shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
              <button
                onClick={() => ctx.startCreate(folder.path, "file")}
                title="New file"
                className="p-1 text-kumo-subtle hover:text-kumo-default rounded"
              >
                <FilePlus size={14} />
              </button>
              <button
                onClick={() => ctx.startCreate(folder.path, "folder")}
                title="New folder"
                className="p-1 text-kumo-subtle hover:text-kumo-default rounded"
              >
                <FolderPlus size={14} />
              </button>
              <button
                onClick={() => ctx.startRename(folder.path)}
                title="Rename"
                className="p-1 text-kumo-subtle hover:text-kumo-default rounded"
              >
                <PencilSimple size={13} />
              </button>
              <button
                onClick={() => ctx.deletePath(folder.path, true)}
                title="Delete folder"
                className="p-1 text-kumo-subtle hover:text-kumo-danger rounded"
              >
                <Trash size={13} />
              </button>
            </div>
          )}
        </div>
      )}

      {open && (
        <div
          {...(isRoot ? dropHandlers : {})}
          className={
            isRoot && isDragOver ? "rounded-md ring-1 ring-kumo-brand/40" : ""
          }
        >
          {ctx.creating && ctx.creating.dir === folder.path && (
            <CreateRow depth={depth} ctx={ctx} />
          )}
          {sortedFolders.map((child) => (
            <FolderView
              key={child.path}
              folder={child}
              depth={isRoot ? depth : depth + 1}
              ctx={ctx}
            />
          ))}
          {sortedFiles.map((doc) => (
            <FileView
              key={doc.path}
              doc={doc}
              depth={isRoot ? depth : depth + 1}
              ctx={ctx}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FileView({
  doc,
  depth,
  ctx,
}: {
  doc: ContextDocumentSummary;
  depth: number;
  ctx: TreeCtx;
}) {
  const Icon = isImageContentType(doc.contentType) ? ImageIcon : FileText;
  const selected = ctx.selectedPath === doc.path;
  return (
    <div
      draggable={ctx.canWrite}
      onDragStart={() => ctx.setDragPath(doc.path)}
      onDragEnd={() => {
        ctx.setDragPath(null);
        ctx.setDragOverDir(null);
      }}
      className={`group flex items-center gap-1.5 rounded-md pr-2 py-1 cursor-pointer transition-colors ${
        selected ? "bg-kumo-brand/15" : "hover:bg-kumo-tint"
      }`}
      style={{ paddingLeft: `${depth * 18 + 8 + 18}px` }}
      onClick={() => ctx.selectFile(doc.path)}
    >
      <Icon size={15} className="text-kumo-subtle flex-shrink-0" />
      {ctx.renaming === doc.path ? (
        <input
          autoFocus
          value={ctx.renameValue}
          onChange={(e) => ctx.setRenameValue(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") ctx.commitRename();
            else if (e.key === "Escape") ctx.cancelRename();
          }}
          // Don't commit when focus moves to an action button; let that click win.
          onBlur={(e) => {
            if (!(e.relatedTarget instanceof HTMLButtonElement)) ctx.commitRename();
          }}
          className="flex-1 min-w-0 rounded border border-kumo-brand bg-kumo-base px-1 py-0 text-sm text-kumo-default focus:outline-none"
        />
      ) : (
        <span
          className={`flex-1 truncate text-sm ${selected ? "text-kumo-strong font-medium" : "text-kumo-default"}`}
        >
          {baseName(doc.path)}
        </span>
      )}
      {ctx.canWrite && (
        <div className="flex flex-shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
          <button
            onClick={(e) => {
              e.stopPropagation();
              ctx.startRename(doc.path);
            }}
            title="Rename"
            className="p-1 text-kumo-subtle hover:text-kumo-default rounded"
          >
            <PencilSimple size={13} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              ctx.deletePath(doc.path, false);
            }}
            title="Delete"
            className="p-1 text-kumo-subtle hover:text-kumo-danger rounded"
          >
            <Trash size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Collection Editor (file manager + document editor)
// ---------------------------------------------------------------------------

function CollectionEditor({
  collectionId,
  selectedPath,
  onSelectPath,
  onBack,
}: {
  collectionId: string;
  selectedPath: string | null;
  onSelectPath: (path: string | null) => void;
  onBack: () => void;
}) {
  const context = useContextApi();
  const toasts = useKumoToastManager();
  const [docs, setDocs] = useState<ContextDocumentSummary[]>([]);
  const [metadata, setMetadata] = useState<ContextCollectionMetadata | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  // Default read-only until access loads so edit controls never flash to viewers.
  const [canWrite, setCanWrite] = useState(false);

  // Parent owns selection; alias keeps local handlers small.
  const setSelectedPath = onSelectPath;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pendingFolders, setPendingFolders] = useState<Set<string>>(new Set());

  const [creating, setCreating] = useState<{
    dir: string;
    kind: "file" | "folder";
  } | null>(null);
  const [creatingName, setCreatingName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dragOverDir, setDragOverDir] = useState<string | null>(null);

  // Tracks unsaved edits in the open document.
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  // Guard tab close/reload; in-iframe navigation is handled by the caller.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);
  const uploadMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!uploadMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (
        uploadMenuRef.current &&
        !uploadMenuRef.current.contains(e.target as Node)
      ) {
        setUploadMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [uploadMenuOpen]);

  const loadDocs = useCallback(async () => {
    try {
      const [meta, list, writable] = await Promise.all([
        context.getContextCollectionMetadata(collectionId),
        context.listContextDocuments(collectionId),
        context.canWriteContextCollection(collectionId),
      ]);
      setMetadata(meta);
      setDocs(list);
      setCanWrite(writable);
    } catch (err) {
      console.error("Failed to load documents:", err);
    } finally {
      setLoading(false);
    }
  }, [context, collectionId]);

  useEffect(() => {
    loadDocs();
  }, [loadDocs]);

  // Reveal the selected document.
  useEffect(() => {
    if (!selectedPath) return;
    const segs = selectedPath.split("/");
    if (segs.length <= 1) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      let acc = "";
      for (let i = 0; i < segs.length - 1; i++) {
        acc = acc ? `${acc}/${segs[i]}` : segs[i];
        next.add(acc);
      }
      return next;
    });
  }, [selectedPath]);

  const toggleFolder = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const startCreate = (dir: string, kind: "file" | "folder") => {
    if (dir) setExpanded((p) => new Set(p).add(dir));
    setCreating({ dir, kind });
    setCreatingName("");
  };
  const cancelCreate = () => {
    setCreating(null);
    setCreatingName("");
  };

  const commitCreate = async () => {
    if (!creating) return;
    const name = creatingName.trim();
    if (!name) {
      cancelCreate();
      return;
    }
    const path = joinPath(creating.dir, name);
    if (creating.kind === "folder") {
      setPendingFolders((p) => new Set(p).add(path));
      setExpanded((p) => new Set(p).add(path));
      cancelCreate();
      return;
    }
    // Files start empty; content type comes from the path.
    try {
      const filePath = /\.[^/]+$/.test(path) ? path : `${path}.md`;
      await context.putContextDocument(collectionId, filePath, {
        description: "",
        body: "",
        contentType: contentTypeFromPath(filePath),
      });
      cancelCreate();
      await loadDocs();
      setSelectedPath(filePath);
    } catch {
      toasts.add({ title: "Failed to create file", variant: "error" });
    }
  };

  const startRename = (path: string) => {
    setRenaming(path);
    setRenameValue(baseName(path));
  };
  const cancelRename = () => {
    setRenaming(null);
    setRenameValue("");
  };
  const commitRename = async () => {
    if (!renaming) return;
    const newName = renameValue.trim();
    const oldName = baseName(renaming);
    if (!newName || newName === oldName) {
      cancelRename();
      return;
    }
    const dest = joinPath(dirName(renaming), newName);
    const wasSelected =
      selectedPath === renaming ||
      (selectedPath?.startsWith(renaming + "/") ?? false);
    try {
      // Empty pending folders exist only locally.
      if (pendingFolders.has(renaming)) {
        setPendingFolders((p) => {
          const next = new Set(p);
          next.delete(renaming);
          next.add(dest);
          return next;
        });
      } else {
        await context.moveContextDocument(
          collectionId,
          renaming,
          dest,
        );
      }
      if (wasSelected && selectedPath) {
        setSelectedPath(replacePathPrefix(selectedPath, renaming, dest));
      }
      cancelRename();
      await loadDocs();
    } catch (err) {
      toasts.add({
        title: `Failed to rename: ${(err as Error).message}`,
        variant: "error",
      });
      cancelRename();
    }
  };

  const moveTo = async (from: string, targetDir: string) => {
    // Reject self/descendant moves; same-dir moves are no-ops.
    if (targetDir === from || targetDir.startsWith(from + "/")) return;
    if (dirName(from) === targetDir) return;
    const dest = joinPath(targetDir, baseName(from));
    try {
      if (pendingFolders.has(from)) {
        setPendingFolders((p) => {
          const next = new Set(p);
          next.delete(from);
          next.add(dest);
          return next;
        });
      } else {
        await context.moveContextDocument(collectionId, from, dest);
      }
      if (selectedPath === from || selectedPath?.startsWith(from + "/")) {
        setSelectedPath(replacePathPrefix(selectedPath, from, dest));
      }
      await loadDocs();
    } catch (err) {
      toasts.add({
        title: `Failed to move: ${(err as Error).message}`,
        variant: "error",
      });
    }
  };

  const deletePath = async (path: string, isDir: boolean) => {
    if (isDir) {
      if (pendingFolders.has(path)) {
        setPendingFolders((p) => {
          const n = new Set(p);
          n.delete(path);
          return n;
        });
        return;
      }
      const inDir = docs.filter(
        (d) => d.path === path || d.path.startsWith(path + "/"),
      );
      if (
        inDir.length > 0 &&
        !confirm(
          `Delete folder "${baseName(path)}" and its ${inDir.length} document(s)?`,
        )
      )
        return;
      try {
        await runWithConcurrency(inDir, 6, (d) =>
          context.deleteContextDocument(collectionId, d.path),
        );
        if (selectedPath?.startsWith(path + "/")) setSelectedPath(null);
        await loadDocs();
      } catch {
        toasts.add({ title: "Failed to delete folder", variant: "error" });
      }
      return;
    }
    if (!confirm(`Delete "${baseName(path)}"? This can't be undone.`)) return;
    try {
      await context.deleteContextDocument(collectionId, path);
      if (selectedPath === path) setSelectedPath(null);
      await loadDocs();
    } catch {
      toasts.add({ title: "Failed to delete document", variant: "error" });
    }
  };

  // Upload files or directories.
  const uploadFiles = async (files: FileList) => {
    let ok = 0,
      failed = 0;
    await runWithConcurrency(Array.from(files), 6, async (file) => {
      const rel = (file as any).webkitRelativePath || file.name;
      // Derive the type from the path (its extension), not the browser-reported file.type, so the
      // stored encoding matches how the editor and the agent read-path interpret it (both go by
      // extension). Trusting file.type caused e.g. .js to be stored base64 but shown as text.
      const ct = contentTypeFromPath(rel);
      try {
        const isText = isTextContentType(ct);
        const body = isText ? await file.text() : await fileToBase64(file);
        await context.putContextDocument(collectionId, rel, {
          // Self-describing files supply their own description; others start blank.
          description: extractDescription(ct, body) ?? "",
          body,
          contentType: ct,
        });
        ok++;
      } catch {
        failed++;
      }
    });
    toasts.add({
      title: `Uploaded ${ok} file${ok !== 1 ? "s" : ""}${failed ? `, ${failed} failed` : ""}`,
      variant: failed ? "error" : "success",
    });
    await loadDocs();
  };

  const extraFolders = useMemo(() => [...pendingFolders], [pendingFolders]);
  const tree = useMemo(
    () => buildTree(docs, extraFolders),
    [docs, extraFolders],
  );

  const ctx: TreeCtx = {
    canWrite,
    selectedPath,
    expanded,
    toggleFolder,
    selectFile: setSelectedPath,
    creating,
    creatingName,
    setCreatingName,
    startCreate,
    commitCreate,
    cancelCreate,
    renaming,
    renameValue,
    setRenameValue,
    startRename,
    commitRename,
    cancelRename,
    deletePath,
    dragPath,
    setDragPath,
    dragOverDir,
    setDragOverDir,
    moveTo,
  };

  // The collection is gone (deleted by an admin) or no longer accessible.
  if (!loading && !metadata) {
    return (
      <div>
        <button
          onClick={onBack}
          className="mb-4 text-sm text-kumo-subtle hover:text-kumo-default transition-colors flex items-center gap-1"
        >
          <CaretRight size={14} className="rotate-180" />
          Back to collections
        </button>
        <div className="rounded-2xl border border-kumo-line bg-kumo-base px-4 py-10 text-center">
          <BookOpen size={32} className="mx-auto mb-3 text-kumo-subtle" />
          <p className="m-0 text-[15px] leading-5 font-medium tracking-[-0.25px] text-kumo-default">
            This collection is no longer available
          </p>
          <p className="mt-1 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
            It may have been deleted.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={onBack}
        className="mb-4 text-sm text-kumo-subtle hover:text-kumo-default transition-colors flex items-center gap-1"
      >
        <CaretRight size={14} className="rotate-180" />
        Back to collections
      </button>

      {metadata && (
        <CollectionHeader
          metadata={metadata}
          canWrite={canWrite}
          onOpenSettings={() => setShowSettings(true)}
        />
      )}
      {metadata && (
        <CollectionSettingsModal
          open={showSettings}
          metadata={metadata}
          collectionId={collectionId}
          onClose={() => setShowSettings(false)}
          onUpdated={loadDocs}
          onDeleted={onBack}
        />
      )}

      {/*
        Master-detail layout. On desktop: tree + editor side by side. On mobile there isn't room
        for both, so we show ONE pane at a time — the tree by default, and the editor once a
        document is selected (with a "Files" button to go back). Selection lives in the URL, so the
        swap is just driven by `selectedPath`.
      */}
      <div className="flex flex-col sm:grid sm:grid-cols-[280px_1fr] gap-4 h-[calc(100vh-260px)] min-h-[420px]">
        {/* File tree — hidden on mobile while a document is open */}
        <div className={`${selectedPath ? "hidden sm:flex" : "flex"} min-h-0 flex-1 sm:flex-none flex-col rounded-xl border border-kumo-line bg-kumo-base overflow-hidden`}>
          {canWrite && (
          <div className="flex items-center gap-1 border-b border-kumo-line px-2 py-1.5">
                <button
                  onClick={() => startCreate("", "file")}
                  title="New file"
                  className="p-1.5 text-kumo-subtle hover:text-kumo-default rounded hover:bg-kumo-tint"
                >
                  <FilePlus size={16} />
                </button>
                <button
                  onClick={() => startCreate("", "folder")}
                  title="New folder"
                  className="p-1.5 text-kumo-subtle hover:text-kumo-default rounded hover:bg-kumo-tint"
                >
                  <FolderPlus size={16} />
                </button>
                <div className="flex-1" />
                <div ref={uploadMenuRef} className="relative">
                  <button
                    onClick={() => setUploadMenuOpen((o) => !o)}
                    title="Upload"
                    className="flex items-center gap-0.5 p-1.5 text-kumo-subtle hover:text-kumo-default rounded hover:bg-kumo-tint"
                  >
                    <UploadSimple size={16} />
                    <CaretDown size={11} />
                  </button>
                  {uploadMenuOpen && (
                    <div className="absolute right-0 z-[1100] mt-1 w-40 overflow-hidden rounded-lg border border-kumo-line bg-kumo-base py-1 shadow-lg">
                      <button
                        onClick={() => {
                          setUploadMenuOpen(false);
                          fileInputRef.current?.click();
                        }}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-kumo-default hover:bg-kumo-tint"
                      >
                        <UploadSimple size={14} /> Upload files
                      </button>
                      <button
                        onClick={() => {
                          setUploadMenuOpen(false);
                          dirInputRef.current?.click();
                        }}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-kumo-default hover:bg-kumo-tint"
                      >
                        <Folder size={14} /> Upload folder
                      </button>
                    </div>
                  )}
                </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) uploadFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <input
              ref={dirInputRef}
              type="file"
              multiple
              // @ts-expect-error non-standard directory upload attribute
              webkitdirectory=""
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) uploadFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
          )}
          <div className="flex-1 overflow-auto py-1">
            {loading ? (
              <p className="px-3 py-2 text-sm text-kumo-subtle">Loading...</p>
            ) : docs.length === 0 && pendingFolders.size === 0 && !creating ? (
              <p className="px-3 py-2 text-sm text-kumo-subtle">
                {canWrite
                  ? "No documents yet. Use the buttons above to add files."
                  : "This collection has no documents yet."}
              </p>
            ) : (
              <FolderView folder={tree} depth={0} ctx={ctx} />
            )}
          </div>
        </div>

        {/* Editor — hidden on mobile until a document is selected */}
        <div className={`${selectedPath ? "flex" : "hidden sm:flex"} min-h-0 flex-1 flex-col rounded-xl border border-kumo-line bg-kumo-base overflow-hidden`}>
          {selectedPath ? (
            <>
              {/* Mobile-only: return to the file tree (desktop shows both panes already). */}
              <button
                onClick={() => setSelectedPath(null)}
                className="flex sm:hidden flex-shrink-0 items-center gap-1 border-b border-kumo-line px-3 py-2 text-sm text-kumo-subtle hover:text-kumo-default transition-colors"
              >
                <CaretRight size={14} className="rotate-180" />
                Files
              </button>
              <div className="min-h-0 flex-1">
                <DocumentEditor
                  key={selectedPath}
                  collectionId={collectionId}
                  path={selectedPath}
                  readOnly={!canWrite}
                  onDirtyChange={setDirty}
                  onChanged={loadDocs}
                  onRenamed={(newPath) => {
                    setDirty(false);
                    setSelectedPath(newPath);
                    loadDocs();
                  }}
                  onDeleted={() => {
                    setDirty(false);
                    setSelectedPath(null);
                    loadDocs();
                  }}
                />
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-kumo-subtle">
              Select a document to view or edit
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Markdown editor (visual WYSIWYG with built-in source toggle)
// ---------------------------------------------------------------------------

function MarkdownDocEditor({
  value,
  onChange,
  readOnly,
  imagePreviewHandler,
}: {
  value: string;
  onChange: (md: string) => void;
  readOnly?: boolean;
  // Resolve markdown image refs to displayable URLs.
  imagePreviewHandler?: (src: string) => Promise<string>;
}) {
  const dark =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  return (
    <MDXEditor
      markdown={value}
      onChange={onChange}
      readOnly={readOnly}
      className={dark ? "dark-theme dark-editor" : ""}
      contentEditableClassName="kb-mdx-content"
      plugins={[
        headingsPlugin(),
        listsPlugin(),
        quotePlugin(),
        thematicBreakPlugin(),
        linkPlugin(),
        linkDialogPlugin(),
        imagePlugin(imagePreviewHandler ? { imagePreviewHandler } : {}),
        tablePlugin(),
        codeBlockPlugin({ defaultCodeBlockLanguage: "text" }),
        codeMirrorPlugin({
          codeBlockLanguages: {
            text: "Text",
            js: "JavaScript",
            ts: "TypeScript",
            json: "JSON",
            bash: "Bash",
            yaml: "YAML",
            md: "Markdown",
            html: "HTML",
            css: "CSS",
            sql: "SQL",
          },
        }),
        markdownShortcutPlugin(),
        // Read-only viewers get no editing toolbar; source view is handled by the page.
        ...(readOnly
          ? []
          : [
              toolbarPlugin({
                toolbarContents: () => (
                  <>
                    <UndoRedo />
                    <BoldItalicUnderlineToggles />
                    <BlockTypeSelect />
                    <ListsToggle />
                    <CreateLink />
                    <InsertImage />
                    <InsertTable />
                    <InsertThematicBreak />
                  </>
                ),
              }),
            ]),
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
// Document Editor (right pane)
// ---------------------------------------------------------------------------

function DocumentEditor({
  collectionId,
  path,
  readOnly,
  onChanged,
  onRenamed,
  onDeleted,
  onDirtyChange,
}: {
  collectionId: string;
  path: string;
  // Hide mutating controls and lock editors when true.
  readOnly: boolean;
  onChanged: () => void;
  // Parent re-selects + reloads after rename.
  onRenamed: (newPath: string) => void;
  onDeleted: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const context = useContextApi();
  const toasts = useKumoToastManager();
  // File name is the title; editing it renames the document.
  const [filename, setFilename] = useState(baseName(path));
  const [renaming, setRenaming] = useState(false);
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  // Content type is path-derived, so renames update rendering immediately.
  const contentType = contentTypeFromPath(path);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  // Markdown uses rich editor by default, source as fallback.
  const [forceSource, setForceSource] = useState(false);
  // MDXEditor normalizes on mount; first emitted value is the clean baseline. null = not captured.
  const mdxBaselineRef = useRef<string | null>(null);

  // Resolve sibling markdown images from the collection and serve them as data URIs.
  const imageUriCacheRef = useRef<Map<string, string>>(new Map());
  const resolveImageSrc = useCallback(
    async (src: string): Promise<string> => {
      if (isExternalImageSrc(src)) return src;
      const resolved = resolveCollectionPath(dirName(path), src);
      const cache = imageUriCacheRef.current;
      const cached = cache.get(resolved);
      if (cached) return cached;
      try {
        const doc = await context.getContextDocument(collectionId, resolved);
        if (doc && isImageContentType(doc.contentType)) {
          const uri = `data:${doc.contentType};base64,${doc.body}`;
          cache.set(resolved, uri);
          return uri;
        }
      } catch {
        // Fall through and return the original src (renders as broken, but doesn't throw).
      }
      return src;
    },
    [context, collectionId, path],
  );

  // Report dirty state for navigation guards.
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  // Clear the guard when this editor unmounts.
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    context.getContextDocument(collectionId, path).then((d) => {
      if (cancelled) return;
      if (d) {
        // Self-describing files use extractedDescription below instead.
        setDescription(d.description);
        setBody(d.body);
        setDirty(false);
        setForceSource(false);
        // Empty docs skip normalization; non-empty baselines come from MDXEditor's first emission.
        mdxBaselineRef.current = d.body === "" ? "" : null;
      }
      // Also clears loading for not-found.
      setLoading(false);
    }).catch((err) => {
      if (cancelled) return;
      setLoading(false);
      toasts.add({
        title: `Failed to load document: ${(err as Error).message}`,
        variant: "error",
      });
    });
    return () => {
      cancelled = true;
    };
  }, [context, collectionId, path]);

  const isText = isTextContentType(contentType);
  const isImage = isImageContentType(contentType);
  const isMarkdown = contentType === "text/markdown";

  // Some formats own their description (frontmatter/YAML/JSON); otherwise the author provides it.
  const extractedDescription = useMemo(
    () => extractDescription(contentType, body),
    [contentType, body],
  );
  const effectiveDescription = extractedDescription ?? description;

  // MDXEditor can't round-trip frontmatter, so edit it separately and recombine into `body`.
  const { frontmatter, content } = useMemo(
    () => (isMarkdown ? splitFrontmatter(body) : { frontmatter: null, content: body }),
    [isMarkdown, body],
  );

  const save = async (overrides?: { body?: string; contentType?: string }) => {
    setSaving(true);
    try {
      await context.putContextDocument(collectionId, path, {
        description: effectiveDescription.trim(),
        body: overrides?.body ?? body,
        contentType: overrides?.contentType ?? contentType,
      });
      setDirty(false);
      toasts.add({ title: "Saved", variant: "success" });
      onChanged();
    } catch {
      toasts.add({ title: "Failed to save", variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  // Rename within the same directory; save dirty text first.
  const commitRename = async () => {
    const trimmed = filename.trim();
    if (!trimmed || trimmed === baseName(path)) {
      setFilename(baseName(path));
      return;
    }
    if (trimmed.includes("/")) {
      toasts.add({ title: "File name can't contain '/'", variant: "error" });
      setFilename(baseName(path));
      return;
    }
    const newPath = joinPath(dirName(path), trimmed);
    setRenaming(true);
    try {
      if (isText && dirty) await save();
      await context.moveContextDocument(collectionId, path, newPath);
      onRenamed(newPath);
    } catch (err) {
      toasts.add({ title: `Rename failed: ${(err as Error).message}`, variant: "error" });
      setFilename(baseName(path));
    } finally {
      setRenaming(false);
    }
  };

  const replaceFile = async (file: File) => {
    const newBody = await fileToBase64(file);
    setBody(newBody);
    // Content type stays path-derived.
    await save({ body: newBody });
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-kumo-subtle">
        Loading…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header: name, path, actions */}
      <div className="flex items-center gap-2 border-b border-kumo-line px-3 py-2">
        <div className="min-w-0 flex-1">
          <input
            value={filename}
            readOnly={readOnly || renaming}
            onChange={(e) => setFilename(e.target.value)}
            onBlur={() => { if (!readOnly) commitRename(); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
              else if (e.key === "Escape") { setFilename(baseName(path)); e.currentTarget.blur(); }
            }}
            className="w-full bg-transparent text-sm font-semibold text-kumo-strong focus:outline-none"
            placeholder="file-name.md"
            title="File name — edit to rename (the extension sets the type)"
          />
          <p className="truncate text-[11px] text-kumo-subtle">
            {path} &middot; <span className="font-mono">{contentType}</span>
          </p>
        </div>
        {isMarkdown && (
          <button
            onClick={() => {
              // Rich remounts MDXEditor; reset baseline for dirty tracking.
              if (forceSource) mdxBaselineRef.current = null;
              setForceSource((s) => !s);
            }}
            title={forceSource ? "Rich text view" : "Source view (full file, incl. frontmatter)"}
            className="flex items-center gap-1 rounded-md border border-kumo-line px-2 py-1 text-xs font-medium text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
          >
            {forceSource ? <><Article size={14} /> Rich</> : <><Code size={14} /> Source</>}
          </button>
        )}
        {!readOnly && (isText || dirty) && (
          <Button
            size="sm"
            onClick={() => save()}
            loading={saving}
            disabled={!dirty}
          >
            <FloppyDisk size={14} className="mr-1" /> Save
          </Button>
        )}
        {!readOnly && !isText && (
          <label className="flex cursor-pointer items-center gap-1 rounded-md border border-kumo-line px-2 py-1 text-xs font-medium text-kumo-subtle hover:text-kumo-default hover:bg-kumo-tint">
            <UploadSimple size={14} /> Replace
            <input
              type="file"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) replaceFile(f);
                e.target.value = "";
              }}
            />
          </label>
        )}
        {!readOnly && (
          <button
            onClick={async () => {
              if (!confirm(`Delete "${baseName(path)}"? This can't be undone.`)) return;
              try {
                await context.deleteContextDocument(collectionId, path);
                onDeleted();
              } catch (err) {
                toasts.add({
                  title: `Failed to delete: ${(err as Error).message}`,
                  variant: "error",
                });
              }
            }}
            title="Delete document"
            className="p-1.5 text-kumo-subtle hover:text-kumo-danger rounded-md hover:bg-kumo-tint"
          >
            <Trash size={16} />
          </button>
        )}
      </div>

      {/* Description: always shown. When the file's format declares its own description (skill
          frontmatter, YAML description, JSON _comment, …) we extract it live and the input is
          read-only — the file owns it. Otherwise (binaries, or text with no declared description)
          it's author-provided. */}
      <div className="flex items-center gap-2 border-b border-kumo-line px-3">
        <input
          value={effectiveDescription}
          disabled={extractedDescription !== null}
          readOnly={readOnly}
          onChange={(e) => {
            setDescription(e.target.value);
            setDirty(true);
          }}
          placeholder="Short description — when is this document relevant? (used for search & by agents)"
          className="min-w-0 flex-1 bg-transparent py-2 text-xs text-kumo-default focus:outline-none disabled:italic disabled:text-kumo-subtle"
        />
        {extractedDescription !== null && (
          <span
            className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-kumo-inactive"
            title="This file declares its own description; edit it in the document below."
          >
            from file
          </span>
        )}
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto">
        {isImage ? (
          <div className="flex h-full items-center justify-center p-4">
            <img
              src={dataUri(contentType, body)}
              alt={filename}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        ) : !isText ? (
          <div className="p-4 text-sm text-kumo-subtle">
            Binary document ({contentType},{" "}
            {Math.round((body.length * 3) / 4 / 1024)} KB). Use Replace to
            update it.
          </div>
        ) : isMarkdown && !forceSource ? (
          <div className="flex h-full flex-col">
            {/* MDXEditor can't round-trip frontmatter; edit it separately. */}
            {frontmatter !== null && (
              <div className="shrink-0 border-b border-kumo-line bg-kumo-elevated">
                <div className="px-3 pt-2 text-[10px] font-medium uppercase tracking-wide text-kumo-subtle">
                  Frontmatter
                </div>
                <textarea
                  value={frontmatter}
                  readOnly={readOnly}
                  spellCheck={false}
                  rows={Math.min(8, frontmatter.split("\n").length + 1)}
                  onChange={(e) => {
                    setBody(joinFrontmatter(e.target.value, content));
                    setDirty(true);
                  }}
                  className="max-h-44 w-full resize-y bg-transparent px-3 py-1.5 font-mono text-[12px] leading-relaxed text-kumo-default outline-none"
                />
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-auto">
              <EditorErrorBoundary
                fallback={
                  <SourceEditor
                    value={content}
                    readOnly={readOnly}
                    onChange={(v) => {
                      setBody(joinFrontmatter(frontmatter, v));
                      setDirty(true);
                    }}
                  />
                }
              >
                <div className="kb-mdx-wrap">
                  <MarkdownDocEditor
                    value={content}
                    readOnly={readOnly}
                    imagePreviewHandler={resolveImageSrc}
                    onChange={(md) => {
                      setBody(joinFrontmatter(frontmatter, md));
                      // First normalized emission is the clean baseline.
                      if (mdxBaselineRef.current === null) mdxBaselineRef.current = md;
                      else setDirty(md !== mdxBaselineRef.current);
                    }}
                  />
                </div>
              </EditorErrorBoundary>
            </div>
          </div>
        ) : (
          <SourceEditor
            value={body}
            readOnly={readOnly}
            onChange={(v) => {
              setBody(v);
              setDirty(true);
            }}
          />
        )}
      </div>
    </div>
  );
}

function SourceEditor({
  value,
  onChange,
  readOnly,
}: {
  value: string;
  onChange: (v: string) => void;
  readOnly?: boolean;
}) {
  // Plain source editor; the sandbox rules out worker-based editors like Monaco.
  return (
    <textarea
      className="h-full w-full resize-none border-0 bg-kumo-base p-3 font-mono text-[13px] leading-relaxed text-kumo-default outline-none"
      value={value}
      readOnly={readOnly ?? false}
      spellCheck={false}
      wrap="off"
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
