import {
  memo,
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useCallback,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  DropdownMenu,
  Select,
  Tooltip,
  useKumoToastManager,
} from "@cloudflare/kumo";

import {
  CaretLeft,
  CaretRight,
  Check,
  X,
  Pencil,
  Trash,
  DotsThreeVertical,
  LinkSimple,
  PlugsConnected,
  ArrowCounterClockwise,
  ArrowsClockwise,
} from "@phosphor-icons/react";
import { RpcStub, RpcTarget } from "capnweb";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import * as Y from "yjs";
import styles from "./ChatInterface.module.css";
import {
  fromModelSelectValue,
  getStoredSelectedModel,
  NO_AGENT_OPTION_VALUE,
  persistSelectedModel,
  toModelSelectValue,
} from "./modelSelection";
import {
  getStoredReasoningExpandedByDefault,
  persistReasoningExpandedByDefault,
} from "./reasoningPreference";
import {
  Overseer,
  GatekeeperClient,
  AiChatMetadata,
  AiChatMessage,
  AiChatSubscriber,
  ActionLogEntry,
  AiChatAuthorInfo,
  CapsuleSpecifier,
  AiChatStreamEvent,
  AiToolCall,
} from "@gadgets/workshop-shared/api";
import { ResourceDescription } from "@gadgets/workshop-shared/gatekeeper";
import CapsuleOverlay from "./CapsuleOverlay";
import type { SelectableItem } from "./ResourcePicker";
import GatekeeperModal from "./GatekeeperModal";
import { handlePickerKeyDown } from "./pickerNavigation";
import { normalizeResourceUrl } from "./resourceMatching";
import DeleteConfirmationDialog from "./components/DeleteConfirmationDialog";
import { WorkshopButton, WorkshopIconButton, WorkshopInput } from "./components/WorkshopControls";
import { useActionEntries } from "./useActions";
import { useAuthenticatedApi } from "./AuthContext";
import { formatFullTimestamp } from "./utils/formatTimestamp";

export interface StreamingProposedChanges {
  updates: Uint8Array[];
  count: number;
}

type DraftUpdateEntry = {
  timestamp: Date;
  author: AiChatAuthorInfo;
  update: Uint8Array;
};

type DraftChatState = {
  entries: DraftUpdateEntry[];
  latestAuthor: AiChatAuthorInfo | null;
};

function refreshDraftLatestAuthor(state: DraftChatState) {
  state.latestAuthor =
    state.entries.length > 0 ? state.entries[state.entries.length - 1].author : null;
}

function pruneDraftEntriesBefore(
  drafts: Map<number, DraftChatState>,
  chatId: number,
  cutoff: Date,
) {
  let state = drafts.get(chatId);
  if (!state) {
    return false;
  }

  const cutoffTime = cutoff.getTime();
  const nextEntries = state.entries.filter(
    (entry) => entry.timestamp.getTime() > cutoffTime,
  );
  if (nextEntries.length === state.entries.length) {
    return false;
  }

  if (nextEntries.length === 0) {
    drafts.delete(chatId);
    return true;
  }

  state.entries = nextEntries;
  refreshDraftLatestAuthor(state);
  return true;
}

function getOrCreateDraftChatState(
  drafts: Map<number, DraftChatState>,
  chatId: number,
): DraftChatState {
  let state = drafts.get(chatId);
  if (!state) {
    state = {
      entries: [],
      latestAuthor: null,
    };
    drafts.set(chatId, state);
  }
  return state;
}

// Auto-resize a textarea element between min and max row heights.
function autoResizeTextarea(textarea: HTMLTextAreaElement, minRows: number, maxRows: number) {
  textarea.style.height = 'auto'
  const cs = getComputedStyle(textarea)
  const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5
  const paddingY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
  const borderY = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)
  const minH = lineHeight * minRows + paddingY + borderY
  const maxH = lineHeight * maxRows + paddingY + borderY
  textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, minH), maxH)}px`
  textarea.style.overflow = textarea.scrollHeight > maxH ? 'auto' : 'hidden'
}

// Internal capsule state tracked within ChatInput (not yet sent).
interface InputCapsule {
  start: number;
  length: number;
  gatekeeperId: number;
  description: ResourceDescription;
}

// Matches http:// and https:// URLs in text, stopping at whitespace and common delimiters.
const URL_REGEX = /https?:\/\/[^\s)>\]]*/g;
const CAPSULE_LINK_PREFIX = "/__gadgets_capsule__/";
const CAPSULE_TOKEN_PREFIX = "GADGETS_CAPSULE_";
const CAPSULE_TOKEN_SUFFIX = "_TOKEN";

type MarkdownAstNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownAstNode[];
};

type TokenizedCapsuleMessage = {
  markdown: string;
  capsulesByToken: Map<string, CapsuleSpecifier>;
};

function generateCapsuleToken(
  message: string,
  index: number,
  usedTokens: Set<string>,
) {
  let attempt = 0;
  while (true) {
    const suffix = attempt === 0 ? "" : `_${attempt}`;
    const token = `${CAPSULE_TOKEN_PREFIX}${index}${suffix}${CAPSULE_TOKEN_SUFFIX}`;
    if (!message.includes(token) && !usedTokens.has(token)) {
      return token;
    }
    attempt++;
  }
}

function buildTokenizedCapsuleMessage(
  message: string,
  capsules: CapsuleSpecifier[],
): TokenizedCapsuleMessage {
  const sorted = [...capsules].sort((a, b) => a.position - b.position);
  const usedTokens = new Set<string>();
  const capsulesByToken = new Map<string, CapsuleSpecifier>();
  let markdown = "";
  let pos = 0;

  for (let i = 0; i < sorted.length; i++) {
    const capsule = sorted[i];
    const token = generateCapsuleToken(message, i, usedTokens);
    usedTokens.add(token);
    capsulesByToken.set(token, capsule);
    markdown += message.slice(pos, capsule.position);
    markdown += token;
    pos = capsule.position + capsule.length;
  }

  markdown += message.slice(pos);
  return { markdown, capsulesByToken };
}

function splitTextOnCapsuleTokens(
  value: string,
  capsulesByToken: Map<string, CapsuleSpecifier>,
): MarkdownAstNode[] | null {
  const tokens = [...capsulesByToken.keys()];
  const parts: MarkdownAstNode[] = [];
  let cursor = 0;
  let foundToken = false;

  while (cursor < value.length) {
    let nextIndex = -1;
    let nextToken: string | null = null;

    for (const token of tokens) {
      const index = value.indexOf(token, cursor);
      if (index !== -1 && (nextIndex === -1 || index < nextIndex)) {
        nextIndex = index;
        nextToken = token;
      }
    }

    if (nextToken === null) {
      break;
    }

    foundToken = true;
    if (nextIndex > cursor) {
      parts.push({
        type: "text",
        value: value.slice(cursor, nextIndex),
      });
    }

    parts.push({
      type: "link",
      url: `${CAPSULE_LINK_PREFIX}${encodeURIComponent(nextToken)}`,
      children: [
        {
          type: "text",
          value: capsulesByToken.get(nextToken)?.description.title ?? nextToken,
        },
      ],
    });

    cursor = nextIndex + nextToken.length;
  }

  if (!foundToken) {
    return null;
  }

  if (cursor < value.length) {
    parts.push({
      type: "text",
      value: value.slice(cursor),
    });
  }

  return parts;
}

function replaceCapsuleTokensInTree(
  node: MarkdownAstNode,
  capsulesByToken: Map<string, CapsuleSpecifier>,
) {
  if (!node.children || node.children.length === 0) {
    return;
  }

  const nextChildren: MarkdownAstNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      const replacementNodes = splitTextOnCapsuleTokens(
        child.value,
        capsulesByToken,
      );
      if (replacementNodes) {
        nextChildren.push(...replacementNodes);
        continue;
      }
    }

    if (child.type !== "code" && child.type !== "inlineCode") {
      replaceCapsuleTokensInTree(child, capsulesByToken);
    }
    nextChildren.push(child);
  }

  node.children = nextChildren;
}

function createCapsuleRemarkPlugin(capsulesByToken: Map<string, CapsuleSpecifier>) {
  return function capsuleRemarkPlugin() {
    return (tree: MarkdownAstNode) => {
      replaceCapsuleTokensInTree(tree, capsulesByToken);
    };
  };
}

function getSafeExternalUrl(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }

  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build a short, skimmable summary for a tool call header.
 *
 * Returns a tuple of [verb, target] so the caller can style them differently
 * (verb = mono name, target = the thing being acted on). Falls back to just the
 * tool name when no useful detail is available.
 */
function getToolCallSummary(tc: AiToolCall): { verb: string; target?: string } {
  switch (tc.toolName) {
    case "readFile":
      return { verb: "readFile", target: tc.input.filename };
    case "writeFile":
      return { verb: "writeFile", target: tc.input.filename };
    case "editFile":
      return { verb: "editFile", target: tc.input.filename };
    case "describeBinding":
      return { verb: "describeBinding", target: String(tc.input.name) };
    case "setBindingHook":
      return {
        verb: "setBindingHook",
        target: tc.input.entrypoint
          ? `${tc.input.bindingName} → ${tc.input.entrypoint}`
          : tc.input.bindingName,
      };
    case "saveCapsuleAsBinding":
      return { verb: "saveCapsuleAsBinding", target: tc.input.bindingName };
    case "executeCode": {
      // Prefer the first non-empty line as a preview.
      const firstLine = tc.input.code
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      return {
        verb: "executeCode",
        target: firstLine
          ? firstLine.length > 60
            ? `${firstLine.slice(0, 57)}…`
            : firstLine
          : undefined,
      };
    }
    case "giveUp":
      return { verb: "giveUp" };
    case "webFetch": {
      let target = tc.input.url;
      try {
        target = new URL(tc.input.url).host;
      } catch {
        // Leave as the raw URL.
      }
      return { verb: "webFetch", target };
    }
    case "observeUserChanges":
      return { verb: "observeUserChanges" };
  }
  // Compile-time exhaustiveness check.
  const _exhaustive: never = tc;
  return { verb: (_exhaustive as { toolName: string }).toolName };
}

function renderCapsulePill(capsule: CapsuleSpecifier) {
  const safeUrl = getSafeExternalUrl(capsule.description.url);
  return (
    <Tooltip
      content={
        safeUrl
          ? (
            <a
              href={safeUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "inherit" }}
            >
              {capsule.description.url}
            </a>
          )
          : capsule.description.url
      }
    >
      <span className={styles.capsulePill}>{capsule.description.title}</span>
    </Tooltip>
  );
}

function getMarkdownComponents(
  capsulesByToken?: Map<string, CapsuleSpecifier>,
): Components {
  return {
    table: ({ node: _node, children, ...props }) => (
      <div className={styles.markdownTableWrapper}>
        <table {...props}>{children}</table>
      </div>
    ),
    a: ({ node: _node, href, children, ...props }) => {
      if (href?.startsWith(CAPSULE_LINK_PREFIX) && capsulesByToken) {
        const token = decodeURIComponent(href.slice(CAPSULE_LINK_PREFIX.length));
        const capsule = capsulesByToken.get(token);
        if (capsule) {
          return renderCapsulePill(capsule);
        }
      }

      const safeHref = getSafeExternalUrl(href);
      if (!safeHref) {
        return <>{children}</>;
      }

      return (
        <a
          {...props}
          href={safeHref}
          target="_blank"
          rel="noopener noreferrer"
        >
          {children}
        </a>
      );
    },
  };
}

const REMARK_PLUGINS_NO_CAPSULES = [remarkGfm];
const MARKDOWN_COMPONENTS_NO_CAPSULES = getMarkdownComponents();
// Render streaming agent text as plain above this length to avoid re-parsing
// the full markdown tree per token. The final message re-renders as markdown.
const LIVE_MARKDOWN_CHAR_LIMIT = 2000;

const MarkdownMessage = memo(function MarkdownMessage(
  { message, capsules }: { message: string; capsules?: CapsuleSpecifier[] },
): ReactNode {
  const tokenizedMessage = useMemo(
    () => capsules && capsules.length > 0
      ? buildTokenizedCapsuleMessage(message, capsules)
      : null,
    [capsules, message],
  );
  const components = useMemo(
    () => tokenizedMessage
      ? getMarkdownComponents(tokenizedMessage.capsulesByToken)
      : MARKDOWN_COMPONENTS_NO_CAPSULES,
    [tokenizedMessage],
  );
  const remarkPlugins = useMemo(
    () => tokenizedMessage
      ? [remarkGfm, createCapsuleRemarkPlugin(tokenizedMessage.capsulesByToken)]
      : REMARK_PLUGINS_NO_CAPSULES,
    [tokenizedMessage],
  );

  return (
    <ReactMarkdown
      skipHtml={true}
      remarkPlugins={remarkPlugins}
      components={components}
    >
      {tokenizedMessage?.markdown ?? message}
    </ReactMarkdown>
  );
});

function StreamingMarkdownMessage({ message }: { message: string }) {
  if (message.length > LIVE_MARKDOWN_CHAR_LIMIT) {
    return <span className="whitespace-pre-wrap break-words">{message}</span>;
  }

  return <MarkdownMessage message={message} />;
}

export const ChatInput = ({
  createCapsuleGatekeeper,
  getOverseer,
  onSend,
  isAgentActive,
  models,
  selectedModel,
  onModelChange,
  pendingConsoleLogCount = 0,
  consoleLogPreview = "",
  consoleLogSeverity = "info",
  onConsumeConsoleLogs = () => "",
  onDiscardConsoleLogs = () => {},
  newChat = false,
  autoFocus = false,
  attachLabel,
  draftUpdateBanner,
  onStop,
}: {
  createCapsuleGatekeeper: (
    accountId: number,
    url: string,
  ) => Promise<RpcStub<GatekeeperClient<any>> | null>;
  // Returns an overseer stub, used by the attach modal to create gatekeepers. Can be async
  // to support lazy provisional-gadget creation on the Home page.
  getOverseer: () => Promise<RpcStub<Overseer>> | RpcStub<Overseer>;
  onSend: (
    message: string,
    modelId: string | null,
    capsules?: CapsuleSpecifier[],
  ) => void;
  isAgentActive: boolean;
  models: AiChatAuthorInfo[];
  selectedModel: string | null;
  onModelChange: (modelId: string | null) => void;
  pendingConsoleLogCount?: number;
  consoleLogPreview?: string;
  consoleLogSeverity?: "error" | "warn" | "info";
  onConsumeConsoleLogs?: () => string;
  onDiscardConsoleLogs?: () => void;
  newChat?: boolean;
  autoFocus?: boolean;
  /** When set, the attach button shows this label with a LinkSimple icon instead of the paperclip icon. */
  attachLabel?: string;
  draftUpdateBanner?: ReactNode;
  onStop?: () => void;
}) => {
  const [inputValue, setInputValue] = useState("");
  const [capsules, setCapsules] = useState<InputCapsule[]>([]);
  const [activeUrl, setActiveUrl] = useState<{
    text: string;
    start: number;
    end: number;
  } | null>(null);
  const [overlayIndex, setOverlayIndex] = useState(0);
  const overlayItemsRef = useRef<SelectableItem[]>([]);
  const overlayActivateRef = useRef<((index: number) => void) | null>(null);

  // Attach modal state
  const [attachModalOpen, setAttachModalOpen] = useState(false);
  // Save the cursor position when the attach modal opens, so we can insert the capsule there.
  const attachCursorPosRef = useRef(0);

  // Refs for the mirror div and the textarea wrapper.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);

  // Keep inputValue in a ref so handleCursorChange can read it without re-binding.
  const inputValueRef = useRef(inputValue);
  inputValueRef.current = inputValue;
  const capsulesRef = useRef(capsules);
  capsulesRef.current = capsules;
  // Sync mirror div size with the textarea via ResizeObserver.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const textarea = wrapper.querySelector("textarea");
    if (!textarea) return;

    const syncMirror = () => {
      const mirror = mirrorRef.current;
      if (!mirror) return;

      // Copy computed styles from the textarea to the mirror so text layout matches exactly.
      const cs = getComputedStyle(textarea);
      mirror.style.fontFamily = cs.fontFamily;
      mirror.style.fontSize = cs.fontSize;
      mirror.style.fontWeight = cs.fontWeight;
      mirror.style.lineHeight = cs.lineHeight;
      mirror.style.letterSpacing = cs.letterSpacing;
      mirror.style.padding = cs.padding;
      mirror.style.border = `${cs.borderWidth} solid transparent`;
      mirror.style.height = `${textarea.offsetHeight}px`;
      mirror.style.width = `${textarea.offsetWidth}px`;
    };

    // Initial sync.
    syncMirror();

    const observer = new ResizeObserver(syncMirror);
    observer.observe(textarea);

    return () => observer.disconnect();
  }, []);

  // Reset overlay selection when the overlay appears or changes URL.
  useEffect(() => {
    setOverlayIndex(0);
  }, [activeUrl]);

  const handleSend = () => {
    if (!inputValue.trim()) return;

    if (capsules.length === 0) {
      // No capsules — simple send.
      onSend(inputValue.trim(), selectedModel);
    } else {
      // Build processed message: replace each capsule title with [i] placeholder.
      const sortedCapsules = [...capsules].sort((a, b) => a.start - b.start);
      let processedMsg = inputValue;
      let cumulativeShift = 0;
      const specifiers: CapsuleSpecifier[] = [];

      for (let i = 0; i < sortedCapsules.length; i++) {
        const c = sortedCapsules[i];
        const placeholder = `[${i}]`;
        const adjustedStart = c.start + cumulativeShift;
        processedMsg =
          processedMsg.slice(0, adjustedStart) +
          placeholder +
          processedMsg.slice(adjustedStart + c.length);
        specifiers.push({
          position: adjustedStart,
          length: placeholder.length,
          gatekeeperId: c.gatekeeperId,
          description: c.description,
        });
        cumulativeShift += placeholder.length - c.length;
      }

      onSend(processedMsg.trim(), selectedModel, specifiers);
    }

    setInputValue("");
    setCapsules([]);
  };

  const handleAttachLogs = () => {
    const formatted = onConsumeConsoleLogs();
    setInputValue((prev) => prev + "\n\n" + formatted);
  };

  // Called when the user selects an account in the CapsuleOverlay.
  // Creates a capsule gatekeeper, fetches its description, and replaces the URL
  // in the input text with the resource title highlighted as a capsule.
  const handleCapsuleCreate = async (accountId: number) => {
    if (!activeUrl) return;

    try {
      // Create the capsule gatekeeper.
      const gk = await createCapsuleGatekeeper(accountId, normalizeResourceUrl(activeUrl.text));
      if (!gk) {
        console.error("Failed to create capsule gatekeeper");
        return;
      }

      try {
        // Fetch ID and description in parallel (promise pipelining).
        const [id, description] = await Promise.all([
          gk.getId(),
          gk.describe(),
        ]);

        // Snapshot the activeUrl position before any state updates.
        const urlStart = activeUrl.start;
        const urlEnd = activeUrl.end;
        // Pad the title with spaces so the mirror highlight has visible interior padding.
        const paddedTitle = ` ${description.title} `;
        const lengthDiff = paddedTitle.length - (urlEnd - urlStart);

        // Replace the URL text with the padded title in inputValue.
        setInputValue(
          (prev) => prev.slice(0, urlStart) + paddedTitle + prev.slice(urlEnd),
        );

        // Adjust positions of existing capsules and add the new one.
        setCapsules((prev) => {
          const adjusted = prev.map((c) => {
            if (c.start >= urlEnd) {
              return { ...c, start: c.start + lengthDiff };
            }
            return c;
          });
          return [
            ...adjusted,
            {
              start: urlStart,
              length: paddedTitle.length,
              gatekeeperId: id,
              description,
            },
          ];
        });

        // Clear activeUrl so the overlay dismisses.
        setActiveUrl(null);

        // Move cursor to end of inserted title on next tick.
        requestAnimationFrame(() => {
          const wrapper = wrapperRef.current;
          if (!wrapper) return;
          const textarea = wrapper.querySelector("textarea");
          if (textarea) {
            const cursorPos = urlStart + paddedTitle.length;
            textarea.setSelectionRange(cursorPos, cursorPos);
            textarea.focus();
          }
        });
      } finally {
        gk[Symbol.dispose]();
      }
    } catch (err) {
      console.error("Failed to create capsule:", err);
    }
  };

  // Called when the user selects a prefix-match "refine" row in the CapsuleOverlay.
  // Replaces the URL in the input with the new (extended) URL and selects the first placeholder.
  const handleRefine = (
    newUrl: string,
    placeholderStart: number,
    placeholderEnd: number,
  ) => {
    if (!activeUrl) return;

    const urlStart = activeUrl.start;
    const urlEnd = activeUrl.end;
    const lengthDiff = newUrl.length - (urlEnd - urlStart);

    // Replace the old URL text with the new URL (which includes the suffix + placeholders).
    setInputValue(
      (prev) => prev.slice(0, urlStart) + newUrl + prev.slice(urlEnd),
    );

    // Adjust positions of any capsules that come after the URL.
    if (lengthDiff !== 0) {
      setCapsules((prev) => {
        const adjusted = prev.map((c) =>
          c.start >= urlEnd ? { ...c, start: c.start + lengthDiff } : c,
        );
        return adjusted;
      });
    }

    // Update activeUrl to reflect the new URL bounds.
    setActiveUrl({
      text: newUrl,
      start: urlStart,
      end: urlStart + newUrl.length,
    });

    // Reset overlay index so the first item is selected after the picker re-evaluates.
    setOverlayIndex(0);

    // Select the first placeholder in the textarea on the next frame.
    requestAnimationFrame(() => {
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      const textarea = wrapper.querySelector("textarea");
      if (textarea) {
        textarea.setSelectionRange(
          urlStart + placeholderStart,
          urlStart + placeholderEnd,
        );
        textarea.focus();
      }
    });
  };

  // Opens the attach modal, saving the current cursor position so we can insert there later.
  const handleAttachOpen = () => {
    const wrapper = wrapperRef.current;
    if (wrapper) {
      const textarea = wrapper.querySelector("textarea");
      if (textarea) {
        attachCursorPosRef.current =
          textarea.selectionStart ?? inputValueRef.current.length;
      } else {
        attachCursorPosRef.current = inputValueRef.current.length;
      }
    } else {
      attachCursorPosRef.current = inputValueRef.current.length;
    }
    setAttachModalOpen(true);
  };

  // Called by the GatekeeperModal when a gatekeeper is created via the attach flow.
  // Inserts a capsule at the previously-saved cursor position.
  const handleAttachCreated = async (gk: RpcStub<GatekeeperClient<any>>) => {
    try {
      // Fetch ID and description in parallel (promise pipelining).
      const [id, description] = await Promise.all([gk.getId(), gk.describe()]);

      const insertPos = attachCursorPosRef.current;
      // Pad the title with spaces so the mirror highlight has visible interior padding.
      const paddedTitle = ` ${description.title} `;

      // Insert the capsule title at the saved cursor position.
      setInputValue(
        (prev) =>
          prev.slice(0, insertPos) + paddedTitle + prev.slice(insertPos),
      );

      // Adjust positions of existing capsules that come after the insertion point.
      setCapsules((prev) => {
        const adjusted = prev.map((c) => {
          if (c.start >= insertPos) {
            return { ...c, start: c.start + paddedTitle.length };
          }
          return c;
        });
        return [
          ...adjusted,
          {
            start: insertPos,
            length: paddedTitle.length,
            gatekeeperId: id,
            description,
          },
        ];
      });

      setAttachModalOpen(false);

      // Move cursor to end of inserted capsule and focus the textarea.
      requestAnimationFrame(() => {
        const wrapper = wrapperRef.current;
        if (!wrapper) return;
        const textarea = wrapper.querySelector("textarea");
        if (textarea) {
          const cursorPos = insertPos + paddedTitle.length;
          textarea.setSelectionRange(cursorPos, cursorPos);
          textarea.focus();
        }
      });
    } finally {
      gk[Symbol.dispose]();
    }
  };

  // Handle text changes: detect if edits overlap any capsule and remove broken ones.
  const handleInputChange = (newValue: string, editCursorPos?: number) => {
    const oldValue = inputValueRef.current;

    if (capsulesRef.current.length === 0) {
      setInputValue(newValue);
      return;
    }

    // Find the region that changed by comparing old and new values.
    let diffStart = 0;
    while (
      diffStart < oldValue.length &&
      diffStart < newValue.length &&
      oldValue[diffStart] === newValue[diffStart]
    ) {
      diffStart++;
    }

    let oldEnd = oldValue.length;
    let newEnd = newValue.length;
    while (
      oldEnd > diffStart &&
      newEnd > diffStart &&
      oldValue[oldEnd - 1] === newValue[newEnd - 1]
    ) {
      oldEnd--;
      newEnd--;
    }

    // The edit replaced oldValue[diffStart..oldEnd) with newValue[diffStart..newEnd).

    // Use the cursor position to disambiguate where the edit actually occurred. The
    // text-diff algorithm attributes the edit to the end of the matching prefix, which
    // is wrong when editing within a run of identical characters (e.g., spaces before a
    // capsule whose leading char is also a space). The cursor position after the edit
    // tells us exactly where the edited region ends in the new value.
    if (editCursorPos !== undefined && editCursorPos < newEnd) {
      const insertedLen = newEnd - diffStart;
      const deletedLen = oldEnd - diffStart;
      const cursorBasedStart = editCursorPos - insertedLen;
      if (cursorBasedStart >= 0) {
        diffStart = cursorBasedStart;
        newEnd = editCursorPos;
        oldEnd = cursorBasedStart + deletedLen;
      }
    }

    const isPureInsertion = oldEnd === diffStart;

    // If the insertion (no deletion) landed inside a capsule, reject the edit.
    if (isPureInsertion) {
      for (const capsule of capsulesRef.current) {
        const capsuleEnd = capsule.start + capsule.length;
        if (diffStart > capsule.start && diffStart < capsuleEnd) {
          // Reject the edit: reset the textarea DOM directly and restore cursor.
          const wrapper = wrapperRef.current;
          const textarea = wrapper?.querySelector("textarea");
          if (textarea) {
            textarea.value = oldValue;
            textarea.setSelectionRange(diffStart, diffStart);
          }
          return;
        }
      }
    }

    // First pass: identify broken capsules and remove their remaining text from
    // newValue. Process from end to start so removals don't shift earlier positions.
    const broken: InputCapsule[] = [];
    for (const capsule of capsulesRef.current) {
      const capsuleEnd = capsule.start + capsule.length;
      if (diffStart < capsuleEnd && oldEnd > capsule.start) {
        broken.push(capsule);
      }
    }

    // Apply the user's edit shift to map old capsule positions into newValue.
    // Then remove any remaining capsule text that the user didn't already delete.
    let adjusted = newValue;
    const editShift = newEnd - diffStart - (oldEnd - diffStart);
    // Sort broken capsules by start position descending so we can splice from the end.
    broken.sort((a, b) => b.start - a.start);
    let extraShift = 0;
    for (const capsule of broken) {
      // Map capsule range into newValue coordinates.
      let remStart = capsule.start;
      let remEnd = capsule.start + capsule.length;
      // The edit replaced old[diffStart..oldEnd) with new[diffStart..newEnd).
      // Portions of the capsule before diffStart are unchanged.
      // Portions within the edit region were already modified by the user's edit.
      // Portions after oldEnd shifted by editShift.
      // We want to remove the parts of the capsule that survived the user's edit.
      if (remEnd <= diffStart) {
        // Capsule is entirely before the edit — shouldn't be broken, skip.
        continue;
      }
      if (remStart >= oldEnd) {
        // Capsule is entirely after the edit — shifted in newValue.
        remStart += editShift;
        remEnd += editShift;
      } else {
        // Capsule overlaps the edit region. Clamp to the parts outside the edit
        // that still exist in newValue, plus the edited region itself.
        // In newValue, the edit region is [diffStart..newEnd).
        // Before the edit: capsule text in [remStart..diffStart) is unchanged.
        // After the edit: capsule text in [oldEnd..capsuleEnd) shifted to [newEnd..newEnd+(capsuleEnd-oldEnd)).
        remStart = Math.min(remStart, diffStart);
        const afterOldEnd = capsule.start + capsule.length - oldEnd;
        if (afterOldEnd > 0) {
          remEnd = newEnd + afterOldEnd;
        } else {
          remEnd = newEnd;
        }
        // Also include any part before diffStart.
        remStart = Math.min(remStart, diffStart);
      }
      const removeLen = remEnd - remStart;
      if (removeLen > 0 && remStart < adjusted.length) {
        adjusted =
          adjusted.slice(0, remStart) +
          adjusted.slice(Math.min(remEnd, adjusted.length));
        extraShift -= removeLen;
      }
    }

    // Second pass: keep non-broken capsules, adjusting positions.
    const totalShift = editShift + extraShift;
    const surviving: InputCapsule[] = [];
    for (const capsule of capsulesRef.current) {
      const capsuleEnd = capsule.start + capsule.length;
      if (diffStart < capsuleEnd && oldEnd > capsule.start) {
        continue; // broken
      }
      if (capsule.start >= oldEnd) {
        surviving.push({ ...capsule, start: capsule.start + totalShift });
      } else {
        surviving.push(capsule);
      }
    }

    // Position cursor where the earliest broken capsule was.
    const cursorPos =
      broken.length > 0
        ? broken[broken.length - 1].start // broken is sorted descending, last = earliest
        : undefined;

    setCapsules(surviving);
    setInputValue(adjusted);

    if (cursorPos !== undefined) {
      requestAnimationFrame(() => {
        const wrapper = wrapperRef.current;
        if (!wrapper) return;
        const textarea = wrapper.querySelector("textarea");
        if (textarea) {
          textarea.setSelectionRange(cursorPos, cursorPos);
        }
      });
    }
  };

  // Detect whether the cursor is currently inside a URL in the input text.
  // Called on every cursor movement (select, click, keyup).
  const handleCursorChange = () => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const textarea = wrapper.querySelector("textarea");
    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const text = inputValueRef.current;

    // Find all URL matches in the current text.
    URL_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = URL_REGEX.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;

      // Cursor is within this URL (inclusive of both endpoints).
      if (cursorPos >= start && cursorPos <= end) {
        // Skip if this region is already a capsule.
        const isInsideCapsule = capsulesRef.current.some(
          (c) => start >= c.start && end <= c.start + c.length,
        );
        if (isInsideCapsule) break;

        setActiveUrl((prev) =>
          prev &&
          prev.text === match![0] &&
          prev.start === start &&
          prev.end === end
            ? prev
            : { text: match![0], start, end },
        );
        return;
      }
    }

    // Cursor is not inside any URL.
    setActiveUrl(null);
  };

  // Build the mirror div content: transparent text with highlighted capsule regions.
  const renderMirrorContent = () => {
    if (capsules.length === 0) {
      // No capsules — mirror is just invisible text (no highlights needed,
      // but we still render it so the ResizeObserver can size it).
      return <span>{inputValue || " "}</span>;
    }

    const sorted = [...capsules].sort((a, b) => a.start - b.start);
    const segments: React.ReactNode[] = [];
    let pos = 0;

    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i];
      // Text before this capsule.
      if (c.start > pos) {
        segments.push(
          <span key={`t${i}`}>{inputValue.slice(pos, c.start)}</span>,
        );
      }
      // Capsule highlight.
      segments.push(
        <span key={`c${i}`} className={styles.capsuleHighlight}>
          {inputValue.slice(c.start, c.start + c.length)}
        </span>,
      );
      pos = c.start + c.length;
    }

    // Remaining text after last capsule.
    if (pos < inputValue.length) {
      segments.push(<span key="tail">{inputValue.slice(pos)}</span>);
    }

    // Ensure at least a space so the div has nonzero height when empty.
    if (segments.length === 0) {
      segments.push(<span key="empty"> </span>);
    }

    return <>{segments}</>;
  };

  // Console log severity is communicated by the dot colour only; the banner
  // chrome stays neutral so a noisy error doesn't paint a red bar above the
  // input.
  const logBannerClass = "border-kumo-line bg-kumo-elevated text-kumo-subtle";
  const logDotClass =
    consoleLogSeverity === "error"
      ? "bg-kumo-danger"
      : consoleLogSeverity === "warn"
        ? "bg-kumo-warning"
        : "bg-kumo-inactive";
  const logKind = consoleLogSeverity === "error"
    ? "error"
    : consoleLogSeverity === "warn"
      ? "warning"
      : "log";

  return (
    // isolation: isolate contains z-indexes used inside the composer (the
    // captured-log floating chip with z-10, the textarea/mirror with z-[1])
    // so they can't paint on top of body-level portaled popovers like the
    // model picker dropdown opening above the composer.
    <div className="px-4 py-3 relative isolate">
      {/* Captured-log floating chip — sits above the composer like a transient pill */}
      {pendingConsoleLogCount > 0 && (
        <div className="pointer-events-none absolute inset-x-4 -top-10 z-10 flex justify-center">
          <div
            className={`pointer-events-auto flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] leading-4 tracking-[-0.2px] shadow-[0_8px_20px_rgba(82,16,0,0.10)] ${logBannerClass}`}
          >
            <Tooltip
              content={
                <pre className="m-0 whitespace-pre-wrap text-[11px] max-h-[300px] overflow-auto max-w-[500px]">
                  {consoleLogPreview}
                </pre>
              }
              side="top"
              align="end"
              asChild
            >
              <button
                onClick={handleAttachLogs}
                className="flex min-w-0 items-center gap-2 truncate text-left hover:text-kumo-default"
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${logDotClass}`} />
                <span className="truncate">
                  Send {pendingConsoleLogCount} captured {logKind}
                  {pendingConsoleLogCount !== 1 ? "s" : ""} to chat
                </span>
              </button>
            </Tooltip>
            <button
              onClick={onDiscardConsoleLogs}
              className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full opacity-60 transition-opacity hover:bg-kumo-tint hover:opacity-100"
              aria-label="Discard captured logs"
            >
              <X size={10} />
            </button>
          </div>
        </div>
      )}

      {/* Prompt card */}
      <div className="relative overflow-visible rounded-2xl border border-kumo-line bg-kumo-base shadow-[inset_0_1px_0_rgba(255,255,255,0.72)]">
        {draftUpdateBanner}
        {/* Textarea */}
        <div className="relative px-4 pb-2 pt-3">
          <div ref={wrapperRef} className={styles.capsuleInputWrapper}>
            {activeUrl && (
              <CapsuleOverlay
                url={activeUrl.text}
                onSelectAccount={(accountId) => {
                  handleCapsuleCreate(accountId);
                }}
                onRefine={handleRefine}
                onDismiss={() => setActiveUrl(null)}
                activeIndex={overlayIndex}
                onItems={(items) => {
                  overlayItemsRef.current = items;
                }}
                activateRef={overlayActivateRef}
              />
            )}
            <div
              ref={mirrorRef}
              className={styles.capsuleMirror}
              aria-hidden="true"
            >
              {renderMirrorContent()}
            </div>
            <textarea
              value={inputValue}
              onChange={(e) => {
                handleInputChange(e.target.value, e.target.selectionStart ?? 0);
                requestAnimationFrame(handleCursorChange);
                // Auto-resize after value change
                autoResizeTextarea(e.target, newChat ? 3 : 1, newChat ? 10 : 4);
              }}
              onSelect={handleCursorChange}
              onClick={handleCursorChange}
              onKeyUp={handleCursorChange}
              placeholder={
                isAgentActive
                  ? "Waiting for agent…"
                  : newChat
                    ? "Start a new conversation…"
                    : "Ask a follow-up…"
              }
              autoFocus={autoFocus}
              rows={newChat ? 3 : 1}
              onKeyDown={(e) => {
                // Enter sends message (unless Shift is held)
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (!isAgentActive) handleSend();
                  return;
                }
                if (activeUrl) {
                  handlePickerKeyDown(
                    e,
                    activeUrl.text,
                    activeUrl.start,
                    overlayIndex,
                    setOverlayIndex,
                    overlayItemsRef,
                    overlayActivateRef,
                  );
                }
              }}
              ref={(el) => {
                // Initial auto-resize on mount
                if (el) autoResizeTextarea(el, newChat ? 3 : 1, newChat ? 10 : 4);
              }}
              className="relative z-[1] w-full resize-none border-none bg-transparent p-0 text-[14px] leading-5 tracking-[-0.25px] text-kumo-default outline-none placeholder:text-kumo-inactive disabled:cursor-not-allowed disabled:text-kumo-inactive"
            />
          </div>
        </div>

        {/* Footer row: model picker left, attach + send right */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-3">
          {/* Model picker */}
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <Select
              aria-label="Select model"
              className="w-full min-w-[120px] max-w-[180px] text-sm"
              value={toModelSelectValue(selectedModel)}
              onValueChange={(value) =>
                onModelChange(fromModelSelectValue(value as string))
              }
              renderValue={(v) => {
                if (v === NO_AGENT_OPTION_VALUE) return "No agent";
                return models.find(m => m.id === v)?.name ?? String(v)
              }}
            >
              {models.map((m) => (
                <Select.Option key={m.id} value={m.id}>
                  {m.name}
                </Select.Option>
              ))}
              <Select.Option value={NO_AGENT_OPTION_VALUE}>
                No agent
              </Select.Option>
            </Select>
          </div>

          {/* Right actions */}
          <div className="ml-auto flex flex-shrink-0 items-center gap-1.5">
            {attachLabel ? (
              <WorkshopButton
                onClick={handleAttachOpen}
                className="!h-8 gap-1.5"
              >
                <LinkSimple size={16} />
                {attachLabel}
              </WorkshopButton>
            ) : (
              <Tooltip content="Attach resource" asChild>
                <WorkshopIconButton
                  onClick={handleAttachOpen}
                  className="!h-8 !w-8 text-kumo-inactive hover:text-kumo-subtle"
                  aria-label="Attach resource"
                >
                  <PlugsConnected size={15} />
                </WorkshopIconButton>
              </Tooltip>
            )}
              {isAgentActive && onStop ? (
                <WorkshopIconButton
                  onClick={onStop}
                  tone="primary"
                  className="!h-8 !w-8"
                  aria-label="Stop agent"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <rect x="5" y="5" width="14" height="14" rx="2" />
                  </svg>
                </WorkshopIconButton>
              ) : (
                <WorkshopIconButton
                  onClick={handleSend}
                  disabled={!inputValue.trim() || isAgentActive}
                  tone="primary"
                  className="!h-8 !w-8 disabled:cursor-not-allowed disabled:opacity-30"
                  aria-label="Send message"
                >
                  {/* Arrow-up icon */}
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                  >
                    <line x1="12" y1="19" x2="12" y2="5" />
                    <polyline points="5 12 12 5 19 12" />
                  </svg>
                </WorkshopIconButton>
              )}
          </div>
        </div>
      </div>

      <GatekeeperModal
        open={attachModalOpen}
        onClose={() => setAttachModalOpen(false)}
        getOverseer={getOverseer}
        onCreated={handleAttachCreated}
      />
    </div>
  );
};

// Helper to compute the state of messages (merged/reverted status and active changes)
interface MessageState {
  // Map from sequence number to status for change messages
  changeStatus: Map<number, "pending" | "merged" | "reverted">;

  // Map from merge/revert sequence to the timestamp they reference
  mergeTimestamps: Map<number, Date>; // sequence -> timestamp of merged-through message
  revertTimestamps: Map<number, Date>; // sequence -> timestamp of reverted-from message

  // The accumulated unmerged/unreverted changes (for the proposed changes view)
  activeChanges: Uint8Array[];
}

type ActionChatMessage = Extract<AiChatMessage, { type: "action" }>;
type ObservationChatMessage = ActionChatMessage & {
  actionLog: NonNullable<ActionChatMessage["actionLog"]> & { type: "observation" };
};

type ChatDisplayEntry =
  | {
      type: "message";
      key: string;
      message: AiChatMessage;
      isAgentContinuation: boolean;
    }
  | {
      type: "observationGroup";
      key: string;
      messages: ObservationChatMessage[];
    };

function isObservationActionMessage(msg: AiChatMessage): msg is ObservationChatMessage {
  return msg.type === "action" && msg.actionLog?.type === "observation";
}

function groupObservationEntries(messages: AiChatMessage[]): ChatDisplayEntry[] {
  const result: ChatDisplayEntry[] = [];
  let lastAgentIdInTurn: string | null = null;

  for (let i = 0; i < messages.length; ) {
    const msg = messages[i];

    if (!isObservationActionMessage(msg)) {
      let isAgentContinuation = false;
      // Track agent continuation across both regular "message" entries and "changes" (checkpoint)
      // entries, since a checkpoint emitted by the same agent immediately after one of its
      // messages is part of the same turn and should suppress redundant author/time chrome.
      if (msg.type === "message" || msg.type === "changes") {
        if (msg.author.type === "user") {
          lastAgentIdInTurn = null;
        } else if (msg.author.type === "agent") {
          isAgentContinuation = lastAgentIdInTurn === msg.author.id;
          lastAgentIdInTurn = msg.author.id;
        }
      }

      result.push({
        type: "message",
        key: `msg-${msg.chatId}-${msg.sequence}`,
        message: msg,
        isAgentContinuation,
      });
      i++;
      continue;
    }

    const observations = [msg];
    let j = i + 1;
    while (j < messages.length) {
      const nextMessage = messages[j];
      if (!isObservationActionMessage(nextMessage)) {
        break;
      }
      observations.push(nextMessage);
      j++;
    }

    if (observations.length === 1) {
      result.push({
        type: "message",
        key: `msg-${msg.chatId}-${msg.sequence}`,
        message: msg,
        isAgentContinuation: false,
      });
    } else {
      result.push({
        type: "observationGroup",
        key: `obs-${msg.chatId}-${msg.sequence}`,
        messages: observations,
      });
    }

    i = j;
  }

  return result;
}

function computeMessageStates(messages: AiChatMessage[]): MessageState {
  const changeStatus = new Map<number, "pending" | "merged" | "reverted">();
  const mergeTimestamps = new Map<number, Date>();
  const revertTimestamps = new Map<number, Date>();

  // Track active updates as we scan (for proposed changes computation)
  let updates: { sequence: number; update: Uint8Array }[] = [];

  for (let msg of messages) {
    if (msg.type === "changes") {
      updates.push({ sequence: msg.sequence, update: msg.update });
      changeStatus.set(msg.sequence, "pending");
    } else if (msg.type === "merge") {
      // Mark changes as merged and drop from active set
      while (updates.length > 0 && updates[0].sequence <= msg.mergeThrough) {
        const merged = updates.shift()!;
        changeStatus.set(merged.sequence, "merged");
      }
      // Find timestamp for the merged-through message
      const refMsg = messages.find((m) => m.sequence === msg.mergeThrough);
      if (refMsg) {
        mergeTimestamps.set(msg.sequence, refMsg.timestamp);
      }
    } else if (msg.type === "revert") {
      // Mark changes as reverted and drop from active set
      while (
        updates.length > 0 &&
        updates[updates.length - 1].sequence >= msg.revertFrom
      ) {
        const reverted = updates.pop()!;
        changeStatus.set(reverted.sequence, "reverted");
      }
      // Find timestamp for the reverted-from message
      const refMsg = messages.find((m) => m.sequence === msg.revertFrom);
      if (refMsg) {
        revertTimestamps.set(msg.sequence, refMsg.timestamp);
      }
    }
  }

  return {
    changeStatus,
    mergeTimestamps,
    revertTimestamps,
    activeChanges: updates.map((u) => u.update),
  };
}

function inferSelectedModelFromMessages(messages: AiChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];

    if (msg.type === "error") {
      if (msg.author.type === "agent") {
        return msg.author.id;
      }
      continue;
    }

    if (msg.type === "message") {
      return msg.author.type === "agent" ? msg.author.id : null;
    }
  }

  return null;
}

function fallbackToStoredModelSelection(
  modelId: string | null,
  availableModels: AiChatAuthorInfo[],
): string | null {
  if (modelId !== null || availableModels.length > 0) {
    return modelId;
  }

  return getStoredSelectedModel(availableModels);
}

interface ChatInterfaceProps {
  overseer: RpcStub<Overseer>;
  selectedChatId: number | null;
  onNavigateToChat: (
    chatId: number | null,
    options?: { replace?: boolean },
  ) => void;
  onProposedChangesChange?: (proposedChanges: Uint8Array | undefined) => void;
  onDraftProposedChangesChange?: (
    updates: StreamingProposedChanges | undefined,
  ) => void;
  onStreamingProposedChangesChange?: (
    updates: StreamingProposedChanges | undefined,
  ) => void;
  onStreamingActiveFileChange?: (filename: string | null | undefined) => void;
  pendingConsoleLogCount: number;
  consoleLogPreview: string;
  consoleLogSeverity: "error" | "warn" | "info";
  onConsumeConsoleLogs: () => string;
  onDiscardConsoleLogs: () => void;
  hideTitleBar?: boolean;
  onChatCountChange?: (count: number, hasChatZero: boolean) => void;
  onAgentActiveChange?: (chatId: number, isActive: boolean) => void;
  sidebarMode?: boolean;
  sidebarWidth?: number;
  onSidebarResize?: (width: number) => void;
  renderExtraTab?: () => React.ReactNode;
  onHasAnyCodeChange?: (hasAnyCode: boolean) => void;
  onSelectedChatHasProposedChangesChange?: (hasProposedChanges: boolean) => void;
  constrainChatWidth?: boolean;
}

// Client-side cache for chats and messages (survives reconnects)
interface ChatCache {
  chats: Map<number, AiChatMetadata>;
  messages: Map<number, AiChatMessage[]>;
  actionMessages: Map<number, Map<string, { chatId: number; sequence: number }>>;
  lastMessageTimestamp: Date | null;
}

type ProvisionalToolCallState = {
  toolCallId: string;
  toolName: AiToolCall["toolName"] | null;
  code: string;
  output: string;
  finished: boolean;
};

type ProvisionalChatState = {
  text: string;
  reasoning: string;
  toolCalls: ProvisionalToolCallState[];
  toolCallsById: Map<string, ProvisionalToolCallState>;
  codeUpdates: Uint8Array[];
  activeEditingFile: string | null | undefined;
};

function createProvisionalChatState(): ProvisionalChatState {
  return {
    text: "",
    reasoning: "",
    toolCalls: [],
    toolCallsById: new Map(),
    codeUpdates: [],
    activeEditingFile: undefined,
  };
}

function clearProvisionalTextState(state: ProvisionalChatState) {
  state.text = "";
  state.reasoning = "";
  state.toolCalls = [];
  state.toolCallsById.clear();
  state.activeEditingFile = undefined;
}

function clearProvisionalCodeState(state: ProvisionalChatState) {
  state.codeUpdates = [];
  state.activeEditingFile = undefined;
}

function isProvisionalChatStateEmpty(state: ProvisionalChatState) {
  return (
    state.text === "" &&
    state.reasoning === "" &&
    state.toolCalls.length === 0 &&
    state.codeUpdates.length === 0 &&
    state.activeEditingFile === undefined
  );
}

function getOrCreateProvisionalToolCall(
  state: ProvisionalChatState,
  toolCallId: string,
  toolName: AiToolCall["toolName"] | null,
) {
  let toolCall = state.toolCallsById.get(toolCallId);
  if (toolCall) {
    if (toolName !== null) {
      toolCall.toolName = toolName;
    }
    return toolCall;
  }

  toolCall = {
    toolCallId,
    toolName,
    code: "",
    output: "",
    finished: false,
  };
  state.toolCallsById.set(toolCallId, toolCall);
  state.toolCalls.push(toolCall);
  return toolCall;
}

function ChatInterface({
  overseer,
  selectedChatId,
  onNavigateToChat,
  onProposedChangesChange,
  onDraftProposedChangesChange,
  onStreamingProposedChangesChange,
  onStreamingActiveFileChange,
  pendingConsoleLogCount,
  consoleLogPreview,
  consoleLogSeverity,
  onConsumeConsoleLogs,
  onDiscardConsoleLogs,
  hideTitleBar,
  onChatCountChange,
  onAgentActiveChange,
  sidebarMode,
  sidebarWidth = 280,
  onSidebarResize,
  renderExtraTab,
  onHasAnyCodeChange,
  onSelectedChatHasProposedChangesChange,
  constrainChatWidth,
}: ChatInterfaceProps) {
  // Persistent cache that survives reconnects
  const toasts = useKumoToastManager();
  const { currentUser } = useAuthenticatedApi();
  const cacheRef = useRef<ChatCache>({
    chats: new Map(),
    messages: new Map(),
    actionMessages: new Map(),
    lastMessageTimestamp: null,
  });
  const provisionalRef = useRef<Map<number, ProvisionalChatState>>(new Map());
  const draftRef = useRef<Map<number, DraftChatState>>(new Map());

  // UI state
  const [_isSubscribed, setIsSubscribed] = useState(false);
  const [chatListReady, setChatListReady] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [updateCounter, setUpdateCounter] = useState(0); // Force re-render when cache updates
  const [proposedChangesVersion, setProposedChangesVersion] = useState(0); // Incremented only for change-affecting messages
  const [draftChangesVersion, setDraftChangesVersion] = useState(0);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState("");
  const [renamingChatId, setRenamingChatId] = useState<number | null>(null);
  const [renamingInput, setRenamingInput] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{
    id: number;
    title: string;
  } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [expandedToolCalls, setExpandedToolCalls] = useState<Set<string>>(
    new Set(),
  );
  const [expandedReasoning, setExpandedReasoning] = useState<Map<string, boolean>>(
    new Map(),
  );
  const [reasoningExpandedByDefault, setReasoningExpandedByDefault] =
    useState(() => getStoredReasoningExpandedByDefault());
  const [expandedActions, setExpandedActions] = useState<Set<number>>(
    new Set(),
  );
  const [expandedObservationGroups, setExpandedObservationGroups] = useState<Set<string>>(
    new Set(),
  );
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set());
  const [processingActions, setProcessingActions] = useState<Set<number>>(
    new Set(),
  );
  const [availableModels, setAvailableModels] = useState<AiChatAuthorInfo[]>(
    [],
  );
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [sidebarActiveTab, setSidebarActiveTab] = useState<
    "chat" | "connections"
  >("chat");
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);

  // Sidebar resize handling.
  //
  // We use Pointer Events with setPointerCapture rather than global mousemove/
  // mouseup listeners. The gadget runs in an iframe; if the user drags the
  // resize handle and the cursor crosses into the iframe, the iframe captures
  // mouse events and the parent window never receives mouseup. The drag would
  // then "stick" to the cursor even after release. Pointer capture routes all
  // pointermove/pointerup events to the handle until release, regardless of
  // what's under the cursor — including iframes.
  const handleSidebarPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      setIsSidebarResizing(true);
    },
    [],
  );
  const handleSidebarPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      const newWidth = Math.max(200, Math.min(500, e.clientX));
      onSidebarResize?.(newWidth);
    },
    [onSidebarResize],
  );
  const handleSidebarPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      setIsSidebarResizing(false);
    },
    [],
  );

  const indexActionMessage = (msg: AiChatMessage) => {
    if (msg.type !== "action") return;
    let locations = cacheRef.current.actionMessages.get(msg.actionId);
    if (!locations) {
      locations = new Map();
      cacheRef.current.actionMessages.set(msg.actionId, locations);
    }
    locations.set(`${msg.chatId}:${msg.sequence}`, {
      chatId: msg.chatId,
      sequence: msg.sequence,
    });
  };

  const removeChatFromActionMessageIndex = (chatId: number) => {
    for (const [actionId, locations] of cacheRef.current.actionMessages) {
      for (const [key, location] of locations) {
        if (location.chatId === chatId) locations.delete(key);
      }
      if (locations.size === 0) cacheRef.current.actionMessages.delete(actionId);
    }
  };

  // Apply page-level cursor + user-select only while a resize is in progress.
  useEffect(() => {
    if (!isSidebarResizing) return;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    return () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isSidebarResizing]);

  // Refs for accessing current values in subscriber callbacks
  const selectedChatIdRef = useRef<number | null>(null);
  const onNavigateToChatRef = useRef(onNavigateToChat);
  onNavigateToChatRef.current = onNavigateToChat;

  // Subscription stub (wrapped in object for useState)
  const subscriptionRef = useRef<RpcStub<{}> | null>(null);

  // Ref for auto-scrolling messages
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isScrolledToBottomRef = useRef(true);

  const scrollMessagesToBottom = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
  }, []);

  // Force a re-render when cache is updated
  const forceUpdate = () => setUpdateCounter((prev) => prev + 1);

  // Batched version of forceUpdate for high-frequency stream events.
  // Coalesces multiple updates within a single animation frame.
  const pendingUpdateRef = useRef(false);
  const scheduleUpdate = () => {
    if (!pendingUpdateRef.current) {
      pendingUpdateRef.current = true;
      requestAnimationFrame(() => {
        pendingUpdateRef.current = false;
        forceUpdate();
      });
    }
  };

  // Get sorted list of chats from cache
  const chatList = Array.from(cacheRef.current.chats.values()).sort(
    (a, b) => b.lastActive.getTime() - a.lastActive.getTime(),
  );

  // Notify parent when chat list changes. Gated on chatListReady so that we
  // don't report 0 from the empty initial cache before listChats() has completed.
  const onChatCountChangeRef = useRef(onChatCountChange);
  onChatCountChangeRef.current = onChatCountChange;
  const hasChatZero = cacheRef.current.chats.has(0);
  useEffect(() => {
    if (chatListReady) {
      onChatCountChangeRef.current?.(chatList.length, hasChatZero);
    }
  }, [chatList.length, chatListReady, hasChatZero]);

  // Notify parent when any chat has proposed changes (code written but not merged).
  const onHasAnyCodeChangeRef = useRef(onHasAnyCodeChange);
  onHasAnyCodeChangeRef.current = onHasAnyCodeChange;
  const anyHasProposedChanges = chatList.some(c => c.hasProposedChanges);
  useEffect(() => {
    if (chatListReady) {
      onHasAnyCodeChangeRef.current?.(anyHasProposedChanges);
    }
  }, [anyHasProposedChanges, chatListReady]);

  // In sidebar mode, auto-select the most recent chat when none is selected.
  useEffect(() => {
    if (
      sidebarMode &&
      selectedChatId === null &&
      chatListReady &&
      chatList.length > 0
    ) {
      onNavigateToChatRef.current(chatList[0].id, { replace: true });
    }
  }, [sidebarMode, selectedChatId, chatListReady, chatList]);

  // Get messages for selected chat (filter out any undefined slots in sparse array)
  // Memoized to prevent creating new array on every render
  const currentMessages = useMemo(() => {
    if (selectedChatId === null) return [];
    return (cacheRef.current.messages.get(selectedChatId) || []).filter(
      (msg) => msg !== undefined,
    );
  }, [selectedChatId, updateCounter]);
  const displayEntries = useMemo(
    () => groupObservationEntries(currentMessages),
    [currentMessages],
  );

  // Hide the user name on user message rows when the only human in the chat is the
  // currently-logged-in user (it would just say "you" on every message). If anyone else has ever
  // posted in this chat, names stay so it's clear who said what.
  const hideOwnUserName = useMemo(() => {
    if (!currentUser) return false;
    let sawSelf = false;
    for (const msg of currentMessages) {
      if (msg.type !== "message" || msg.author.type !== "user") continue;
      if (msg.author.id !== currentUser.id) return false;
      sawSelf = true;
    }
    return sawSelf;
  }, [currentMessages, currentUser]);

  const lastMessageSequence = currentMessages[currentMessages.length - 1]?.sequence;

  // Get metadata for selected chat
  const currentChatMetadata =
    selectedChatId !== null ? cacheRef.current.chats.get(selectedChatId) : null;

  const onSelectedChatHasProposedChangesChangeRef = useRef(onSelectedChatHasProposedChangesChange);
  onSelectedChatHasProposedChangesChangeRef.current = onSelectedChatHasProposedChangesChange;
  useEffect(() => {
    if (selectedChatId !== null && currentChatMetadata === undefined) {
      return;
    }

    onSelectedChatHasProposedChangesChangeRef.current?.(
      currentChatMetadata?.hasProposedChanges === true,
    );
  }, [currentChatMetadata?.hasProposedChanges, currentChatMetadata, selectedChatId]);

  const currentProvisionalState =
    selectedChatId !== null
      ? (provisionalRef.current.get(selectedChatId) ?? null)
      : null;

  const currentDraftState =
    selectedChatId !== null ? (draftRef.current.get(selectedChatId) ?? null) : null;
  const currentDraftChangesCount = currentDraftState?.entries.length ?? 0;

  const provisionalToolCalls = currentProvisionalState?.toolCalls ?? [];
  const hasRunningProvisionalToolCall = provisionalToolCalls.some(
    (toolCall) => !toolCall.finished,
  );

  const useConstrainedChatWidth = sidebarMode || constrainChatWidth;

  const currentStreamingChanges = currentProvisionalState?.codeUpdates;
  const currentStreamingChangesCount = currentStreamingChanges?.length ?? 0;
  const currentStreamingActiveFile = currentProvisionalState?.activeEditingFile;
  const currentDraftChangesState = useMemo(():
    | StreamingProposedChanges
    | undefined => {
    if (!currentDraftState || currentDraftChangesCount === 0) {
      return undefined;
    }
    return {
      updates: currentDraftState.entries.map((entry) => entry.update),
      count: currentDraftChangesCount,
    };
  }, [currentDraftChangesCount, currentDraftState, draftChangesVersion, selectedChatId]);
  const currentStreamingState = useMemo(():
    | StreamingProposedChanges
    | undefined => {
    if (!currentStreamingChanges || currentStreamingChangesCount === 0) {
      return undefined;
    }
    return {
      updates: currentStreamingChanges,
      count: currentStreamingChangesCount,
    };
  }, [selectedChatId, currentStreamingChanges, currentStreamingChangesCount]);

  const hasVisibleProvisionalContent =
    !!currentProvisionalState &&
    (currentProvisionalState.text !== "" ||
      currentProvisionalState.reasoning !== "" ||
      provisionalToolCalls.length > 0);

  const isAgentActive = !!currentChatMetadata?.activeAgent;
  const activeAgent = currentChatMetadata?.activeAgent;

  // Notify parent when agent active state changes
  const onAgentActiveChangeRef = useRef(onAgentActiveChange);
  onAgentActiveChangeRef.current = onAgentActiveChange;
  const prevIsAgentActiveRef = useRef(isAgentActive);
  useEffect(() => {
    if (
      selectedChatId !== null &&
      isAgentActive !== prevIsAgentActiveRef.current
    ) {
      prevIsAgentActiveRef.current = isAgentActive;
      onAgentActiveChangeRef.current?.(selectedChatId, isAgentActive);
    }
  }, [isAgentActive, selectedChatId]);

  // Track whether user is scrolled to the bottom of the messages area.
  const handleMessagesScroll = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    // Allow a small tolerance for fractional scroll positions and layout rounding.
    isScrolledToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= 8;
  }, []);

  // Auto-scroll to bottom when messages change, but only if already at bottom
  useLayoutEffect(() => {
    if (isScrolledToBottomRef.current) {
      scrollMessagesToBottom();
    }
  }, [
    currentMessages,
    hasVisibleProvisionalContent,
    currentStreamingChangesCount,
    scrollMessagesToBottom,
  ]);

  // Always scroll to bottom when switching chats
  useLayoutEffect(() => {
    isScrolledToBottomRef.current = true;
    scrollMessagesToBottom();
  }, [selectedChatId, scrollMessagesToBottom]);

  // Initialize title input when selecting a chat
  useEffect(() => {
    if (currentChatMetadata) {
      setTitleInput(currentChatMetadata.title);
    }
  }, [currentChatMetadata?.title]);

  // Update selected model when switching chats
  useEffect(() => {
    if (selectedChatId === null) {
      setSelectedModel(getStoredSelectedModel(availableModels));
    } else {
      // For existing threads:
      // 1. If an AI agent is currently active, use that agent's model
      if (activeAgent) {
        setSelectedModel(activeAgent.id);
      } else {
        // 2. Otherwise, derive the model from the most recent agent message or agent error.
        setSelectedModel(
          fallbackToStoredModelSelection(
            inferSelectedModelFromMessages(currentMessages),
            availableModels,
          ),
        );
      }
    }
  }, [selectedChatId, availableModels, currentMessages, activeAgent]);

  // Keep the ref in sync with selectedChatId state
  useEffect(() => {
    selectedChatIdRef.current = selectedChatId;
  }, [selectedChatId]);

  // Notify parent when proposed changes change for the selected chat.
  // Only recomputes when proposedChangesVersion changes (i.e. a "changes", "merge",
  // or "revert" message arrives), NOT on every message.
  useEffect(() => {
    if (!currentChatMetadata?.hasProposedChanges) {
      onProposedChangesChange?.(undefined);
      return;
    }

    // Read messages directly from the cache (always current) rather than using the
    // memoized currentMessages, so we don't need it as a dependency.
    const messages =
      selectedChatId !== null
        ? (cacheRef.current.messages.get(selectedChatId) || []).filter(
            (msg) => msg !== undefined,
          )
        : [];
    const { activeChanges } = computeMessageStates(messages);

    if (activeChanges.length === 0) {
      onProposedChangesChange?.(undefined);
      return;
    }

    const mergedUpdate =
      activeChanges.length === 1
        ? activeChanges[0]
        : Y.mergeUpdatesV2(activeChanges);

    onProposedChangesChange?.(mergedUpdate);
  }, [
    currentChatMetadata?.hasProposedChanges,
    proposedChangesVersion,
    selectedChatId,
    onProposedChangesChange,
  ]);

  useEffect(() => {
    onStreamingProposedChangesChange?.(currentStreamingState);
  }, [currentStreamingState, onStreamingProposedChangesChange]);

  useEffect(() => {
    onDraftProposedChangesChange?.(currentDraftChangesState);
  }, [currentDraftChangesState, onDraftProposedChangesChange]);

  useEffect(() => {
    onStreamingActiveFileChange?.(currentStreamingActiveFile);
  }, [currentStreamingActiveFile, onStreamingActiveFileChange]);

  // Proper class implementation of AiChatSubscriber
  // This is necessary so the server receives a single stub for the object,
  // not separate stubs for each method
  class ChatSubscriberImpl extends RpcTarget implements AiChatSubscriber {
    metadata(chat: AiChatMetadata) {
      cacheRef.current.chats.set(chat.id, chat);
      forceUpdate();
    }

    deleted(chatId: number) {
      // Remove from cache
      cacheRef.current.chats.delete(chatId);
      cacheRef.current.messages.delete(chatId);
      removeChatFromActionMessageIndex(chatId);
      provisionalRef.current.delete(chatId);
      draftRef.current.delete(chatId);

      // If currently viewing this chat, go back to list
      // Use replace to prevent browser-back returning to the deleted chat
      if (selectedChatIdRef.current === chatId) {
        onNavigateToChatRef.current(null, { replace: true });
      }

      forceUpdate();
    }

    draftUpdate(
      chatId: number,
      timestamp: Date,
      author: AiChatAuthorInfo,
      update: Uint8Array,
    ) {
      let draft = getOrCreateDraftChatState(draftRef.current, chatId);
      let existingIndex = draft.entries.findIndex(
        (entry) => entry.timestamp.getTime() === timestamp.getTime(),
      );

      if (existingIndex >= 0) {
        draft.entries[existingIndex] = { timestamp, author, update };
      } else {
        draft.entries.push({ timestamp, author, update });
        draft.entries.sort(
          (left, right) => left.timestamp.getTime() - right.timestamp.getTime(),
        );
      }

      refreshDraftLatestAuthor(draft);
      if (existingIndex >= 0) {
        setDraftChangesVersion((prev) => prev + 1);
      }
      scheduleUpdate();
    }

    draftCleared(chatId: number) {
      if (draftRef.current.delete(chatId)) {
        scheduleUpdate();
      }
    }

    message(msg: AiChatMessage) {
      // Use sequence number as index to make this idempotent
      // This handles both duplicate subscriptions (React strict mode) and race conditions

      // Get or initialize messages array for this chat
      let messages = cacheRef.current.messages.get(msg.chatId);
      if (!messages) {
        messages = [];
        cacheRef.current.messages.set(msg.chatId, messages);
      }

      // Set message at sequence index (idempotent)
      messages[msg.sequence] = msg;
      indexActionMessage(msg);

      // Update last message timestamp
      if (
        !cacheRef.current.lastMessageTimestamp ||
        msg.timestamp > cacheRef.current.lastMessageTimestamp
      ) {
        cacheRef.current.lastMessageTimestamp = msg.timestamp;
      }

      // Only trigger proposed-changes recomputation for message types that affect the code.
      // "merge" is excluded: it reclassifies changes from proposed to committed but doesn't
      // change the total code (committed + proposed). The hasProposedChanges metadata
      // dependency handles the transition when all changes are merged.
      if (msg.type === "changes" || msg.type === "revert") {
        setProposedChangesVersion((prev) => prev + 1);
      }

      if (msg.type === "changes" && msg.author.type === "user") {
        pruneDraftEntriesBefore(draftRef.current, msg.chatId, msg.timestamp);
      }

      const provisional = provisionalRef.current.get(msg.chatId);
      if (provisional) {
        if (msg.type === "message") {
          clearProvisionalTextState(provisional);
        } else if (msg.type === "changes") {
          clearProvisionalCodeState(provisional);
        } else if (msg.type === "error") {
          clearProvisionalTextState(provisional);
          clearProvisionalCodeState(provisional);
        }

        if (isProvisionalChatStateEmpty(provisional)) {
          provisionalRef.current.delete(msg.chatId);
        }
      }

      forceUpdate();
    }

    stream(chatId: number, event: AiChatStreamEvent) {
      let provisional = provisionalRef.current.get(chatId);

      if (!provisional) {
        provisional = createProvisionalChatState();
        provisionalRef.current.set(chatId, provisional);
      }

      switch (event.type) {
        case "textDelta":
          provisional.text += event.delta;
          break;
        case "reasoningDelta":
          provisional.reasoning += event.delta;
          break;
        case "toolCallStarted": {
          getOrCreateProvisionalToolCall(
            provisional,
            event.toolCallId,
            event.toolName,
          );
          if (event.toolName === "executeCode") {
            setExpandedToolCalls((prev) => new Set(prev).add(event.toolCallId));
          }
          break;
        }
        case "toolCodeDelta": {
          const toolCall = getOrCreateProvisionalToolCall(
            provisional,
            event.toolCallId,
            null,
          );
          toolCall.code += event.delta;
          break;
        }
        case "toolOutputDelta": {
          const toolCall = getOrCreateProvisionalToolCall(
            provisional,
            event.toolCallId,
            null,
          );
          toolCall.output += event.delta;
          break;
        }
        case "toolCallFinished": {
          const toolCall = getOrCreateProvisionalToolCall(
            provisional,
            event.toolCallId,
            null,
          );
          toolCall.finished = true;
          break;
        }
        case "setActiveFile":
          provisional.activeEditingFile = event.filename;
          break;
        case "codeReset":
          provisional.codeUpdates = [];
          break;
        case "codeUpdate":
          provisional.codeUpdates.push(event.update);
          break;
        case "clear":
          clearProvisionalTextState(provisional);
          clearProvisionalCodeState(provisional);
          break;
      }

      if (isProvisionalChatStateEmpty(provisional)) {
        provisionalRef.current.delete(chatId);
      }

      scheduleUpdate();
    }
  }

  // Keep stable subscriber instance across re-renders
  const subscriberRef = useRef(new ChatSubscriberImpl());

  // Subscribe to chat updates
  useEffect(() => {
    let isMounted = true;

    const subscribe = async () => {
      try {
        // Subscribe using startAfter if we have a last message timestamp
        const startAfter = cacheRef.current.lastMessageTimestamp || undefined;

        // Don't await - subscribeToChat returns a promise that doesn't resolve until disconnect
        // Store the promise itself as the subscription
        // Pass the subscriber instance (which is now a proper class instance)
        const subscription = overseer.subscribeToChat(
          subscriberRef.current,
          startAfter,
        );

        subscriptionRef.current = subscription;

        if (isMounted) {
          setIsSubscribed(true);

          // After subscribing, load the list of chats and models
          // This is safe because subscription will catch any new activity
          const [chats, models] = await Promise.all([
            overseer.listChats(),
            overseer.listModels(),
          ]);

          chats.forEach((chat) => {
            cacheRef.current.chats.set(chat.id, chat);
          });
          setChatListReady(true);

          setAvailableModels(models);

          setSelectedModel(getStoredSelectedModel(models));

          forceUpdate();
        }
      } catch (err) {
        console.error("Failed to subscribe to chats:", err);
        toasts.add({ title: "Unable to load conversations", variant: "error" });
      }
    };

    subscribe();

    // Set up reconnection handling
    overseer.onRpcBroken?.((error) => {
      console.warn("RPC connection broken:", error);
      setIsSubscribed(false);
      // Cache persists, component will get new overseer prop and resubscribe
    });

    return () => {
      isMounted = false;
      if (subscriptionRef.current) {
        subscriptionRef.current[Symbol.dispose]();
      }
      // Note: subscriberRef.current stays alive for potential resubscription
    };
  }, [overseer]);

  // Patch cached chat messages on action upserts.
  useActionEntries(overseer, (record) => {
    if (applyActionLogUpdateToCachedMessages(record)) scheduleUpdate();
  });

  // Reset per-chat UI state when selectedChatId changes
  useEffect(() => {
    setExpandedToolCalls(new Set());
    setExpandedReasoning(new Map());
    setExpandedActions(new Set());
    setExpandedObservationGroups(new Set());
    setExpandedErrors(new Set());
    setIsEditingTitle(false);
    setSidebarActiveTab("chat");
  }, [selectedChatId]);

  const initializedReasoningCountRef = useRef(0);
  useEffect(() => {
    initializedReasoningCountRef.current = 0;
  }, [selectedChatId]);

  useEffect(() => {
    if (initializedReasoningCountRef.current > currentMessages.length) {
      initializedReasoningCountRef.current = 0;
    }

    setExpandedReasoning((prev) => {
      const next = new Map(prev);
      let changed = false;

      for (let i = initializedReasoningCountRef.current; i < currentMessages.length; i++) {
        const msg = currentMessages[i];
        if (msg.type !== "message" || !msg.reasoning) continue;

        const key = `${msg.chatId}-${msg.sequence}`;
        if (!next.has(key)) {
          next.set(key, reasoningExpandedByDefault);
          changed = true;
        }
      }

      initializedReasoningCountRef.current = currentMessages.length;

      if (selectedChatId !== null && currentProvisionalState?.reasoning) {
        const key = `stream-${selectedChatId}`;
        if (!next.has(key)) {
          next.set(key, reasoningExpandedByDefault);
          changed = true;
        }
      }

      return changed ? next : prev;
    });
  }, [
    currentMessages,
    currentProvisionalState?.reasoning,
    reasoningExpandedByDefault,
    selectedChatId,
  ]);

  // Load chat history when selectedChatId changes to a non-null value
  useEffect(() => {
    if (selectedChatId === null) return;

    // If we don't have messages for this chat yet, load them
    if (!cacheRef.current.messages.has(selectedChatId)) {
      let cancelled = false;
      setIsLoading(true);
      (async () => {
        try {
          const history = await overseer.getChatHistory(selectedChatId);
          if (cancelled) return;

          // Get or initialize messages array for this chat
          let messages = cacheRef.current.messages.get(selectedChatId);
          if (!messages) {
            messages = [];
            cacheRef.current.messages.set(selectedChatId, messages);
          }

          // Populate using sequence numbers as indices
          // If subscription already added some messages, this will fill in the gaps
          // (and harmlessly overwrite any that match, since content is identical)
          history.forEach((msg) => {
            messages[msg.sequence] = msg;
            indexActionMessage(msg);
          });

          // Update last message timestamp if needed
          if (history.length > 0) {
            const lastMsg = history[history.length - 1];
            if (
              !cacheRef.current.lastMessageTimestamp ||
              lastMsg.timestamp > cacheRef.current.lastMessageTimestamp
            ) {
              cacheRef.current.lastMessageTimestamp = lastMsg.timestamp;
            }
          }

          // History may contain change-affecting messages that the subscriber
          // didn't deliver (they predated the subscription). Bump the version so
          // the proposed-changes effect re-evaluates with the loaded messages.
          setProposedChangesVersion((prev) => prev + 1);
          forceUpdate();
        } catch (err) {
          console.error("Failed to load chat history:", err);
          // If loading fails (e.g., invalid chat ID), navigate back to chat list
          if (!cancelled) {
            onNavigateToChatRef.current(null, { replace: true });
          }
        } finally {
          if (!cancelled) {
            setIsLoading(false);
          }
        }
      })();

      return () => {
        cancelled = true;
      };
    }
    // LSP reports an error here, but tsc does not.
    // The LSP error is due to bugs that need to be fixed in Cap'n Web.
  }, [selectedChatId, overseer]);

  // Handle sending a message (always called from ChatInput with explicit messageText)
  const handleSend = async (
    messageText?: string,
    modelId?: string | null,
    capsules?: CapsuleSpecifier[],
  ) => {
    const message = messageText?.trim();
    if (!message) return;

    // Use provided modelId or fall back to selectedModel
    const model = modelId !== undefined ? modelId : selectedModel;

    try {
      if (selectedChatId === null) {
        // Create a new chat (with optional capsules).
        const newChatId = await overseer.newChat(message, model, capsules);
        onNavigateToChatRef.current(newChatId);
      } else {
        // Send message to existing chat.
        await overseer.sendChatMessage(
          selectedChatId,
          message,
          model,
          capsules || undefined,
        );
      }
    } catch (err) {
      console.error("Failed to send message:", err);
      toasts.add({ title: "Failed to send message", variant: "error" });
    }
  };

  // Handle creating a new chat from the sidebar (always creates, never sends to existing)
  const handleNewChatSend = async (
    messageText?: string,
    modelId?: string | null,
    capsules?: CapsuleSpecifier[],
  ) => {
    const message = messageText?.trim();
    if (!message) return;
    const model = modelId !== undefined ? modelId : selectedModel;
    try {
      const newChatId = await overseer.newChat(message, model, capsules);
      onNavigateToChatRef.current(newChatId);
    } catch (err) {
      console.error("Failed to create new chat:", err);
      toasts.add({ title: "Failed to start conversation", variant: "error" });
    }
  };

  // Handle model change
  const handleModelChange = (modelId: string | null) => {
    setSelectedModel(modelId);
    persistSelectedModel(modelId);
  };

  // Handle stopping the agent
  const handleStop = async () => {
    if (selectedChatId === null) return;

    try {
      await overseer.stopAgent(selectedChatId);
    } catch (err) {
      console.error("Failed to stop agent:", err);
      toasts.add({ title: "Failed to stop agent", variant: "error" });
    }
  };

  // Handle saving chat title
  const handleSaveChatTitle = async () => {
    if (selectedChatId === null || !titleInput.trim()) {
      return;
    }

    try {
      await overseer.setChatTitle(selectedChatId, titleInput.trim());

      // Update the cache with the new title
      const chat = cacheRef.current.chats.get(selectedChatId);
      if (chat) {
        cacheRef.current.chats.set(selectedChatId, {
          ...chat,
          title: titleInput.trim(),
        });
        forceUpdate();
      }

      setIsEditingTitle(false);
      toasts.add({ title: "Chat title updated successfully", variant: "success" });
    } catch (err) {
      console.error("Failed to update chat title:", err);
      toasts.add({ title: "Failed to update chat title", variant: "error" });
    }
  };

  // Handle canceling title edit
  const handleCancelTitleEdit = () => {
    setTitleInput(currentChatMetadata?.title || "");
    setIsEditingTitle(false);
  };

  // Handle deleting a chat. Can be called from the chat header (no args) or the
  // chat list (with explicit chatId/title).
  const handleDeleteChat = (chatId?: number, chatTitle?: string) => {
    const id = chatId ?? selectedChatId;
    const title = chatTitle ?? currentChatMetadata?.title ?? "this chat";
    if (id === null || id === undefined) return;
    setDeleteTarget({ id, title });
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await overseer.deleteChat(deleteTarget.id);
      toasts.add({ title: "Chat deleted successfully", variant: "success" });
    } catch (err) {
      console.error("Failed to delete chat:", err);
      toasts.add({ title: "Failed to delete chat", variant: "error" });
    }
    setIsDeleting(false);
    setDeleteTarget(null);
  };

  // Handle saving a renamed chat from the list view
  const handleSaveListRename = async (chatId: number) => {
    if (!renamingInput.trim()) {
      setRenamingChatId(null);
      return;
    }
    try {
      await overseer.setChatTitle(chatId, renamingInput.trim());
      const chat = cacheRef.current.chats.get(chatId);
      if (chat) {
        cacheRef.current.chats.set(chatId, {
          ...chat,
          title: renamingInput.trim(),
        });
        forceUpdate();
      }
      toasts.add({ title: "Chat title updated successfully", variant: "success" });
    } catch (err) {
      console.error("Failed to update chat title:", err);
      toasts.add({ title: "Failed to update chat title", variant: "error" });
    }
    setRenamingChatId(null);
  };

  // Handle merging changes up to a specific sequence number
  const handleMergeChanges = async (
    mergeThrough: number | null,
    options?: { includeDraft?: boolean },
  ) => {
    if (selectedChatId === null) return;

    try {
      await overseer.mergeChanges(selectedChatId, mergeThrough, options);
      toasts.add({ title: "Changes accepted", variant: "success" });
    } catch (err) {
      console.error("Failed to accept changes:", err);
      toasts.add({ title: "Failed to accept changes", variant: "error" });
    }
  };

  const handleFinalizeDraftChanges = async () => {
    if (selectedChatId === null) return;

    try {
      await overseer.finalizeChatDraft(selectedChatId);
      toasts.add({ title: "Changes saved", variant: "success" });
    } catch (err) {
      console.error("Failed to save changes:", err);
      toasts.add({ title: "Failed to save changes", variant: "error" });
    }
  };

  const handleDiscardDraftChanges = async () => {
    if (selectedChatId === null) return;

    try {
      await overseer.discardChatDraftChanges(selectedChatId);
      draftRef.current.delete(selectedChatId);
      forceUpdate();
      toasts.add({ title: "Changes discarded", variant: "success" });
    } catch (err) {
      console.error("Failed to discard changes:", err);
      toasts.add({ title: "Failed to discard changes", variant: "error" });
    }
  };

  const applyActionLogUpdateToCachedMessages = (record: ActionLogEntry): boolean => {
    let changed = false;
    const locations = cacheRef.current.actionMessages.get(record.id);
    if (!locations) return false;

    for (const [key, location] of locations) {
      const messages = cacheRef.current.messages.get(location.chatId);
      const msg = messages?.[location.sequence];
      if (msg?.type !== "action" || msg.actionId !== record.id) {
        locations.delete(key);
        continue;
      }

      const nextMessages = [...messages!];
      nextMessages[location.sequence] = { ...msg, actionLog: record };
      cacheRef.current.messages.set(location.chatId, nextMessages);
      changed = true;
    }

    if (locations.size === 0) cacheRef.current.actionMessages.delete(record.id);
    return changed;
  };

  const applyOptimisticActionState = (actionId: number, state: "approved" | "rejected"): boolean => {
    let changed = false;
    const locations = cacheRef.current.actionMessages.get(actionId);
    if (!locations) return false;

    for (const [key, location] of locations) {
      const messages = cacheRef.current.messages.get(location.chatId);
      const msg = messages?.[location.sequence];
      if (msg?.type !== "action" || msg.actionId !== actionId || !msg.actionLog) {
        locations.delete(key);
        continue;
      }

      const nextMessages = [...messages!];
      nextMessages[location.sequence] = {
        ...msg,
        actionLog: { ...msg.actionLog, state, appliedAt: new Date() },
      };
      cacheRef.current.messages.set(location.chatId, nextMessages);
      changed = true;
    }

    if (locations.size === 0) cacheRef.current.actionMessages.delete(actionId);
    return changed;
  };

  // Handle reverting changes from a specific sequence number onward
  const handleRevertChanges = async (revertFrom: number) => {
    if (selectedChatId === null) return;

    try {
      await overseer.revertChanges(selectedChatId, revertFrom);
      toasts.add({ title: "Draft rewound", variant: "success" });
    } catch (err) {
      console.error("Failed to rewind draft:", err);
      toasts.add({ title: "Failed to rewind draft", variant: "error" });
    }
  };

  // Handle approving an action from the chat thread
  const handleApproveAction = async (actionId: number) => {
    setProcessingActions((prev) => new Set(prev).add(actionId));
    try {
      await overseer.approveAction(actionId);
      if (applyOptimisticActionState(actionId, "approved")) forceUpdate();
    } catch (err) {
      console.error("Failed to approve action:", err);
      toasts.add({ title: "Failed to approve action", variant: "error" });
    } finally {
      setProcessingActions((prev) => {
        const next = new Set(prev);
        next.delete(actionId);
        return next;
      });
    }
  };

  // Handle rejecting an action from the chat thread
  const handleRejectAction = async (actionId: number) => {
    setProcessingActions((prev) => new Set(prev).add(actionId));
    try {
      await overseer.rejectAction(actionId);
      if (applyOptimisticActionState(actionId, "rejected")) forceUpdate();
    } catch (err) {
      console.error("Failed to reject action:", err);
      toasts.add({ title: "Failed to reject action", variant: "error" });
    } finally {
      setProcessingActions((prev) => {
        const next = new Set(prev);
        next.delete(actionId);
        return next;
      });
    }
  };

  // Toggle tool call expansion
  const toggleToolCallExpansion = (toolCallId: string) => {
    setExpandedToolCalls((prev) => {
      const next = new Set(prev);
      if (next.has(toolCallId)) {
        next.delete(toolCallId);
      } else {
        next.add(toolCallId);
      }
      return next;
    });
  };

  // Toggle action description expansion
  const toggleActionExpansion = (actionId: number) => {
    setExpandedActions((prev) => {
      const next = new Set(prev);
      if (next.has(actionId)) {
        next.delete(actionId);
      } else {
        next.add(actionId);
      }
      return next;
    });
  };

  const toggleObservationGroupExpansion = (groupKey: string) => {
    setExpandedObservationGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  };

  // Toggle reasoning expansion
  const toggleReasoningExpansion = (messageKey: string) => {
    const nextExpanded =
      !(expandedReasoning.get(messageKey) ?? reasoningExpandedByDefault);

    setExpandedReasoning((prev) => {
      const next = new Map(prev);
      next.set(messageKey, nextExpanded);
      return next;
    });

    persistReasoningExpandedByDefault(nextExpanded);
    setReasoningExpandedByDefault(nextExpanded);
  };

  // Toggle error message expansion
  const toggleErrorExpansion = (messageKey: string) => {
    setExpandedErrors((prev) => {
      const next = new Set(prev);
      if (next.has(messageKey)) {
        next.delete(messageKey);
      } else {
        next.add(messageKey);
      }
      return next;
    });
  };

  // Handle retrying the agent after an error
  const handleRetry = async () => {
    if (
      selectedChatId === null ||
      selectedModel === null
    ) {
      return;
    }

    try {
      await overseer.retryAgent(selectedChatId, selectedModel);
    } catch (err) {
      console.error("Failed to retry agent:", err);
      toasts.add({ title: "Failed to retry agent", variant: "error" });
    }
  };

  // Compute message states (merged/reverted status)
  const messageStates = useMemo(
    () => computeMessageStates(currentMessages),
    [currentMessages],
  );
  const lastDurablePendingChange = useMemo(
    () => {
      for (let i = currentMessages.length - 1; i >= 0; i--) {
        const msg = currentMessages[i];
        if (
          msg.type === "changes" &&
          messageStates.changeStatus.get(msg.sequence) === "pending"
        ) {
          return msg;
        }
      }

      return null;
    },
    [currentMessages, messageStates],
  );

  const renderActionCard = (
    msg: ActionChatMessage,
    options?: { nested?: boolean },
  ) => {
    const log = msg.actionLog;
    if (!log) return null;

    const isAct = log.type === "action";
    const state = log.state;
    const open = expandedActions.has(msg.actionId);
    const isProc = processingActions.has(msg.actionId);
    const safeResourceUrl = getSafeExternalUrl(log.resourceUrl);

    if (options?.nested && !isAct) {
      return (
        <div className="rounded-xl border border-kumo-line bg-kumo-base px-3 py-2.5 text-[13px] leading-[18px] tracking-[-0.25px]">
          <div className="mb-1.5 flex items-center gap-2 text-[12px] leading-4 text-kumo-subtle">
            <span className="rounded-full border border-kumo-line bg-kumo-tint px-2 py-0.5 text-[11px] leading-4 font-medium tracking-[-0.2px]">
              Observation
            </span>
            {log.bindingName && (
              <code className="rounded bg-kumo-fill px-1 font-mono text-[11px] text-kumo-subtle">
                {log.bindingName}
              </code>
            )}
            <span className="min-w-0 flex-1 truncate">
              {safeResourceUrl ? (
                <a
                  href={safeResourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  {log.resourceTitle}
                </a>
              ) : (
                log.resourceTitle
              )}
            </span>
            <Tooltip content={formatFullTimestamp(msg.timestamp)} asChild>
              <span className="flex-shrink-0 font-mono text-[11px] text-kumo-inactive">
                {msg.timestamp.toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </Tooltip>
          </div>
          <p className="m-0 text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
            {log.description.title}
          </p>
          <p className="mt-1.5 mb-0 text-[12px] leading-[18px] tracking-[-0.2px] text-kumo-subtle">
            {log.description.description}
          </p>
        </div>
      );
    }

    const isPending = isAct && state === "pending";
    const isAction = isAct;
    const showDescription = isPending || open;
    const PILL_NEUTRAL = "border-kumo-line bg-kumo-tint text-kumo-subtle";
    const PILL_DANGER = "border-kumo-danger/20 bg-kumo-danger-tint text-kumo-danger";
    const PILL_BRAND = "border-kumo-brand/30 bg-kumo-brand/10 text-kumo-brand";

    let pillCls: string;
    let pillLabel: string;
    if (!isAction) {
      pillCls = PILL_NEUTRAL;
      pillLabel = "Observation";
    } else if (state === "approved") {
      pillCls = PILL_NEUTRAL;
      pillLabel = "Approved";
    } else if (state === "rejected") {
      pillCls = PILL_DANGER;
      pillLabel = "Rejected";
    } else {
      pillCls = PILL_BRAND;
      pillLabel = "Needs approval";
    }
    const cardCls = isAction && isPending
      ? "border-l-2 border-l-kumo-brand border-y border-r border-y-kumo-line border-r-kumo-line bg-kumo-base"
      : "border border-kumo-line bg-kumo-base";
    const showPill = !isPending;
    const headerContent = (
        <div className="flex items-start gap-3">
          {!isPending && (
          <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-kumo-subtle">
            <CaretRight
              size={12}
              className={`transition-transform duration-150 ease-out ${open ? "rotate-90" : ""}`}
              weight="bold"
            />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {showPill && (
              <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] leading-4 font-medium tracking-[-0.2px] ${pillCls}`}>
                {pillLabel}
              </span>
            )}
            <span
              className={`min-w-0 truncate tracking-[-0.25px] text-kumo-default ${
                isPending
                  ? "text-[14px] leading-5 font-semibold"
                  : "text-[13px] leading-[18px]"
              }`}
            >
              {log.description.title}
            </span>
          </div>
          {(log.resourceTitle || log.bindingName) && (
            <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
              {log.resourceTitle && (
                <span className="min-w-0 truncate">
                  {safeResourceUrl ? (
                    <a
                      href={safeResourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {log.resourceTitle}
                    </a>
                  ) : (
                    log.resourceTitle
                  )}
                </span>
              )}
              {log.resourceTitle && log.bindingName && (
                <span className="text-kumo-inactive" aria-hidden="true">·</span>
              )}
              {log.bindingName && (
                <span className="font-mono text-[11px] text-kumo-inactive">
                  {log.bindingName}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    );

    return (
      <div
        className={`${options?.nested ? "" : "ml-10 max-w-[78%]"} overflow-hidden rounded-xl text-[13px] leading-[18px] tracking-[-0.25px] ${cardCls}`}
      >
        {isPending ? (
          <div className="px-3 py-2.5">{headerContent}</div>
        ) : (
          <div
            role="button"
            tabIndex={0}
            aria-expanded={open}
            onClick={() => toggleActionExpansion(msg.actionId)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                toggleActionExpansion(msg.actionId);
              }
            }}
            className="cursor-pointer px-3 py-2.5 transition-colors hover:bg-kumo-tint/40 focus-visible:bg-kumo-tint/40 focus-visible:outline-none"
          >
            {headerContent}
          </div>
        )}

        {showDescription && (
          <div
            className={`border-t border-kumo-line bg-kumo-elevated/60 px-3 py-2 ${
              isPending ? "border-b" : ""
            }`}
          >
            <div className={`chat-panel max-h-[200px] overflow-y-auto pr-1 text-[13px] leading-[19px] tracking-[-0.25px] text-kumo-subtle ${styles.markdownContent}`}>
              <MarkdownMessage message={log.description.description} />
            </div>
          </div>
        )}

        {isPending && (
          <div className="flex justify-end gap-2 px-3 py-2">
            <WorkshopButton
              onClick={() => handleRejectAction(msg.actionId)}
              disabled={isProc}
              className="!h-8"
            >
              Reject
            </WorkshopButton>
            <WorkshopButton
              onClick={() => handleApproveAction(msg.actionId)}
              disabled={isProc}
              tone="primary"
              className="!h-8"
            >
              Approve
            </WorkshopButton>
          </div>
        )}
      </div>
    );
  };

  // ─── avatars ────────────────────────────────────────────────────────────────
  const AssistantAvatar = () => (
    <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-kumo-contrast shadow-[0_4px_12px_rgba(82,16,0,0.12)]">
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        className="text-white"
      >
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      </svg>
    </div>
  );
  // ─── sidebar list content (reused in both modes) ──────────────────────────
  const chatListPanel = (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Chat list header */}
      <div className="flex h-12 flex-shrink-0 items-center border-b border-kumo-line px-4">
        <span className="text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
          Conversations
        </span>
      </div>
      {/* Chat list */}
      <div className="chat-panel flex-1 overflow-y-auto bg-kumo-base p-3">
        {!chatListReady ? (
          <div className="flex items-center justify-center py-10">
            <div className="w-5 h-5 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
          </div>
        ) : chatList.length === 0 ? (
          <p className="text-sm text-kumo-inactive text-center py-8">
            No conversations yet
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            <p className="mb-2 px-1 text-[11px] font-medium uppercase tracking-[0.08em] text-kumo-inactive">Recent</p>
            {chatList.map((chat) => (
              <div key={chat.id} className="relative">
                {renamingChatId === chat.id ? (
                  /* ── Inline rename mode ─────────────────────────────── */
                  <div
                    className={`flex w-full items-center gap-2 rounded-xl border px-3 py-2.5 ${
                      chat.spawnerName
                        ? "border-[var(--color-compute-100)]/30 bg-[var(--color-compute-200)]"
                        : "border-kumo-brand bg-kumo-elevated"
                    }`}
                  >
                    <input
                      type="text"
                      value={renamingInput}
                      onChange={(e) => setRenamingInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSaveListRename(chat.id);
                        if (e.key === "Escape") setRenamingChatId(null);
                      }}
                      autoFocus
                      className="min-w-0 flex-1 rounded-md border border-kumo-brand bg-kumo-tint px-2 py-1 text-[13px] font-medium text-kumo-default focus:outline-none"
                    />
                    <WorkshopIconButton
                      onClick={() => handleSaveListRename(chat.id)}
                      disabled={!renamingInput.trim()}
                      className="!h-6 !w-6 disabled:opacity-30"
                      aria-label="Save conversation title"
                    >
                      <Check size={13} />
                    </WorkshopIconButton>
                    <WorkshopIconButton
                      onClick={() => setRenamingChatId(null)}
                      className="!h-6 !w-6"
                      aria-label="Cancel conversation rename"
                    >
                      <X size={13} />
                    </WorkshopIconButton>
                  </div>
                  ) : (
                  <div
                    className={`group flex w-full cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                      sidebarMode && chat.id === selectedChatId
                        ? "border-kumo-line bg-kumo-base shadow-[0_8px_20px_rgba(82,16,0,0.06)]"
                        : "border-transparent hover:border-kumo-line hover:bg-kumo-elevated"
                    }`}
                  >
                    <div
                      className="flex-1 min-w-0"
                      onClick={() => onNavigateToChat(chat.id)}
                    >
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                          {chat.title}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="truncate text-[12px] leading-4 text-kumo-inactive">
                          {chat.lastActive.toLocaleDateString()}{" "}
                          {chat.lastActive.toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                        {chat.totalCost != null && (
                          <span className="flex-shrink-0 font-mono text-[12px] text-kumo-inactive">
                            ${chat.totalCost.toFixed(4)}
                          </span>
                        )}
                      </div>
                    </div>
                    {chat.activeAgent ? (
                      <span className="inline-flex items-center gap-1 flex-shrink-0 rounded-full bg-kumo-tint px-2 py-0.5 text-[11px] leading-4 font-medium text-kumo-brand">
                        <span className="h-1.5 w-1.5 rounded-full bg-kumo-brand animate-pulse" />
                        Working
                      </span>
                    ) : chat.hasProposedChanges ? (
                      <span
                        className="flex-shrink-0 rounded-full bg-kumo-warning-tint px-2 py-0.5 text-[11px] leading-4 font-medium text-kumo-warning border border-kumo-warning/20"
                        title="Has pending changes"
                      >
                        Pending changes
                      </span>
                    ) : chat.spawnerName ? (
                      <span className="flex-shrink-0 rounded-full border border-kumo-brand/20 bg-kumo-tint px-2 py-0.5 text-[11px] leading-4 font-medium text-kumo-brand">
                        Agent: {chat.spawnerName}
                      </span>
                    ) : null}
                    {/* ··· menu */}
                    <DropdownMenu>
                      <DropdownMenu.Trigger
                        render={
                          <WorkshopIconButton
                            aria-label={`Actions for ${chat.title}`}
                            onClick={(e) => e.stopPropagation()}
                            className="!h-7 !w-7 flex-shrink-0 text-kumo-inactive opacity-0 focus:opacity-100 group-hover:opacity-100 data-[popup-open]:opacity-100"
                          >
                            <DotsThreeVertical size={14} />
                          </WorkshopIconButton>
                        }
                      />
                      <DropdownMenu.Content
                        onClick={(event) => event.stopPropagation()}
                        className="!z-[1100] !min-w-[144px] rounded-lg border border-kumo-line bg-kumo-base p-1 shadow-[0_8px_20px_rgba(82,16,0,0.10)]"
                      >
                        <DropdownMenu.Item
                          icon={<Pencil size={12} className="mr-2" />}
                          onClick={() => {
                            setRenamingInput(chat.title);
                            setRenamingChatId(chat.id);
                          }}
                          className="!h-auto rounded-md !px-2.5 !py-1.5 text-[12px] leading-4 tracking-[-0.2px] text-kumo-default transition-colors data-highlighted:bg-kumo-tint"
                        >
                          Rename
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          icon={<Trash size={12} className="mr-2" />}
                          variant="danger"
                          onClick={() => handleDeleteChat(chat.id, chat.title)}
                          className="!h-auto rounded-md !px-2.5 !py-1.5 text-[12px] leading-4 tracking-[-0.2px] transition-colors data-highlighted:bg-kumo-danger-tint"
                        >
                          Delete
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* New chat input — pinned to bottom. ChatInput supplies its own
          horizontal padding, so the wrapper just adds the top divider; no
          extra p-4 (which would shrink the input vs. the in-chat composer). */}
      <div className="flex-shrink-0 border-t border-kumo-line">
        <ChatInput
          createCapsuleGatekeeper={(accountId, url) =>
            overseer.newGatekeeper(accountId, url)
          }
          getOverseer={() => overseer}
          onSend={handleNewChatSend}
          isAgentActive={false}
          models={availableModels}
          selectedModel={selectedModel}
          onModelChange={handleModelChange}
          newChat
        />
      </div>
    </div>
  );

  // ─── main render ─────────────────────────────────────────────────────────────
  return (
    <div
      className={`flex h-full bg-kumo-base ${sidebarMode ? "flex-row" : "flex-col"}`}
    >
      {/* ── Sidebar mode: conversations list on the left ───────────────────── */}
      {sidebarMode && (
        <>
          <div
            className="flex flex-col border-r border-kumo-line flex-shrink-0"
            style={{ width: sidebarWidth }}
          >
            {chatListPanel}
          </div>
          {/* Resize handle */}
          <div
            className="w-1 flex-shrink-0 bg-kumo-line hover:bg-kumo-brand cursor-col-resize transition-colors relative touch-none"
            onPointerDown={handleSidebarPointerDown}
            onPointerMove={handleSidebarPointerMove}
            onPointerUp={handleSidebarPointerUp}
            onPointerCancel={handleSidebarPointerUp}
          >
            <div className="absolute inset-y-0 -left-1 -right-1" />
          </div>
        </>
      )}

      {/* ── Non-sidebar mode: show list OR chat ────────────────────────────── */}
      {!sidebarMode && selectedChatId === null ? (
        chatListPanel
      ) : selectedChatId !== null ? (
        <div className="flex-1 flex flex-col overflow-auto">
          {/* Tab bar — in sidebar mode, show Chat / Connections tabs */}
          {sidebarMode && (
            <div className="flex h-12 flex-shrink-0 items-center gap-5 border-b border-kumo-line px-4">
              <button
                onClick={() => setSidebarActiveTab("chat")}
                className={`relative flex h-full cursor-pointer items-center text-[13px] leading-[18px] tracking-[-0.25px] transition-colors ${
                  sidebarActiveTab === "chat"
                    ? "font-medium text-kumo-default after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:rounded-full after:bg-kumo-contrast/70"
                    : "font-normal text-kumo-subtle hover:text-kumo-default"
                }`}
              >
                Chat
              </button>
              <button
                onClick={() => setSidebarActiveTab("connections")}
                className={`relative flex h-full cursor-pointer items-center text-[13px] leading-[18px] tracking-[-0.25px] transition-colors ${
                  sidebarActiveTab === "connections"
                    ? "font-medium text-kumo-default after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:rounded-full after:bg-kumo-contrast/70"
                    : "font-normal text-kumo-subtle hover:text-kumo-default"
                }`}
              >
                Connections
              </button>
            </div>
          )}

          {/* Connections tab content */}
          {sidebarMode &&
            sidebarActiveTab === "connections" &&
            renderExtraTab && (
              <div className="flex-1 overflow-auto">{renderExtraTab()}</div>
            )}

          {/* Chat content — hidden when connections tab is active in sidebar mode */}
          {(!sidebarMode || sidebarActiveTab === "chat") && (
            <>
              {/* Chat sub-header — hidden in sidebar mode (list is always visible) */}
              {!hideTitleBar && !sidebarMode && (
                <div className="flex h-12 flex-shrink-0 items-center justify-between gap-2 border-b border-kumo-line px-4">
                  <WorkshopIconButton
                    onClick={() => onNavigateToChat(null)}
                    className="!h-8 !w-8 flex-shrink-0"
                    title="Back to conversations"
                    aria-label="Back to conversations"
                  >
                    <CaretLeft size={14} />
                  </WorkshopIconButton>

                  {isEditingTitle ? (
                    <div className="flex items-center gap-1 flex-1 min-w-0">
                      <WorkshopInput
                        type="text"
                        value={titleInput}
                        onChange={(e) => setTitleInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleSaveChatTitle();
                          if (e.key === "Escape") handleCancelTitleEdit();
                        }}
                        autoFocus
                        className="!h-8 min-w-0 flex-1 bg-kumo-tint text-[13px] font-medium"
                      />
                      <WorkshopIconButton
                        onClick={handleSaveChatTitle}
                        disabled={!titleInput.trim()}
                        className="!h-8 !w-8 hover:text-kumo-brand disabled:opacity-30"
                        aria-label="Save chat title"
                      >
                        <Check size={13} />
                      </WorkshopIconButton>
                      <WorkshopIconButton
                        onClick={handleCancelTitleEdit}
                        className="!h-8 !w-8"
                        aria-label="Cancel title edit"
                      >
                        <X size={13} />
                      </WorkshopIconButton>
                    </div>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                        {currentChatMetadata?.title || "Chat"}
                      </span>
                      <WorkshopIconButton
                        onClick={() => setIsEditingTitle(true)}
                        className="!h-8 !w-8 flex-shrink-0 text-kumo-inactive hover:text-kumo-subtle"
                        title="Rename chat"
                        aria-label="Rename chat"
                      >
                        <Pencil size={11} />
                      </WorkshopIconButton>
                    </>
                  )}

                  <WorkshopIconButton
                    onClick={() => handleDeleteChat()}
                    danger
                    className="!h-8 !w-8 flex-shrink-0 text-kumo-inactive"
                    title="Delete chat"
                    aria-label="Delete chat"
                  >
                    <Trash size={14} />
                  </WorkshopIconButton>
                </div>
              )}

              {/* Messages */}
              <div
                ref={messagesContainerRef}
                onScroll={handleMessagesScroll}
                className="flex-1 overflow-y-auto chat-panel"
              >
                {isLoading ? (
                  <div className="flex items-center justify-center py-10">
                    <div className="w-5 h-5 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : (
                  <div
                    className={`space-y-4 px-4 pt-5 ${pendingConsoleLogCount > 0 ? "pb-14" : "pb-5"} ${useConstrainedChatWidth ? "mx-auto w-full max-w-[760px]" : ""}`}
                  >
                    {displayEntries.map((entry) => {
                      const isAgentContinuation = entry.type === "message" ? entry.isAgentContinuation : false;
                      if (entry.type === "observationGroup") {
                        const open = expandedObservationGroups.has(entry.key);
                        const lastObservation = entry.messages[entry.messages.length - 1];

                        return (
                          <div key={entry.key} className="ml-10 max-w-[78%] overflow-hidden rounded-xl border border-kumo-line bg-kumo-elevated text-[13px] leading-[18px] tracking-[-0.25px]">
                            <button
                              onClick={() => toggleObservationGroupExpansion(entry.key)}
                              className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-kumo-tint/60"
                            >
                              <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                                className={`flex-shrink-0 transition-transform ${open ? "rotate-90" : ""} text-kumo-subtle`}
                              >
                                <polyline points="9 18 15 12 9 6" />
                              </svg>
                              <span className="rounded-full border border-kumo-line bg-kumo-tint px-2 py-0.5 text-[11px] leading-4 font-medium text-kumo-subtle">Observations</span>
                              <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-kumo-subtle">
                                {entry.messages.length} observations
                              </span>
                              <Tooltip content={formatFullTimestamp(lastObservation.timestamp)} asChild>
                                <span className="flex-shrink-0 font-mono text-[11px] text-kumo-inactive">
                                  {lastObservation.timestamp.toLocaleTimeString([], {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })}
                                </span>
                              </Tooltip>
                            </button>
                            {open && (
                              <div className="space-y-2 border-t border-kumo-line bg-kumo-base p-2">
                                {entry.messages.map((observation) => (
                                  <div key={`${observation.chatId}-${observation.sequence}`}>
                                    {renderActionCard(observation, { nested: true })}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      }

                      const msg = entry.message;

                      return (
                        <div key={entry.key}>
                        {/* ── user / AI text message ── */}
                        {msg.type === "message" && (
                          msg.author.type === "user" ? (
                            <div className="flex flex-col items-end">
                              <div className="mb-1 flex justify-end gap-2 text-[11px] leading-4 text-kumo-inactive">
                                {/* hideOwnUserName implies currentUser is non-null (see memo). */}
                                {!(hideOwnUserName && msg.author.id === currentUser?.id) && (
                                  <span className="font-medium">{msg.author.name}</span>
                                )}
                                <Tooltip content={formatFullTimestamp(msg.timestamp)} asChild>
                                  <span className="font-mono">
                                    {msg.timestamp.toLocaleTimeString([], {
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    })}
                                  </span>
                                </Tooltip>
                              </div>
                              <div className={`w-fit max-w-[78%] rounded-2xl rounded-br-md border border-kumo-line bg-kumo-tint px-3.5 py-2.5 text-[14px] leading-[21px] tracking-[-0.25px] text-kumo-default shadow-[inset_0_1px_0_rgba(255,255,255,0.55)] ${styles.markdownContent}`}>
                                <MarkdownMessage
                                  message={msg.message}
                                  capsules={msg.capsules}
                                />
                              </div>
                            </div>
                          ) : (
                          <div className="flex items-start gap-3">
                            {isAgentContinuation ? (
                              <div className="w-7 flex-shrink-0" aria-hidden="true" />
                            ) : (
                              <AssistantAvatar />
                            )}
                            <div className="min-w-0 w-full max-w-[78%] space-y-1.5 py-0.5">
                              {(() => {
                                const key = `${msg.chatId}-${msg.sequence}`;
                                const reasoningOpen =
                                  msg.reasoning
                                    ? expandedReasoning.get(key) ??
                                      reasoningExpandedByDefault
                                    : false;
                                return (
                                  <>
                                    {!isAgentContinuation && (
                                      <div className="mb-1.5 flex items-center gap-2">
                                        <span className="text-[12px] leading-4 font-semibold tracking-[-0.2px] text-kumo-default">
                                          {msg.author.name}
                                        </span>
                                         <Tooltip content={formatFullTimestamp(msg.timestamp)} asChild>
                                           <span className="font-mono text-[11px] text-kumo-inactive">
                                             {msg.timestamp.toLocaleTimeString([], {
                                               hour: "2-digit",
                                               minute: "2-digit",
                                             })}
                                           </span>
                                         </Tooltip>
                                         {msg.reasoning && (
                                          <>
                                            <span className="text-[11px] text-kumo-inactive" aria-hidden="true">·</span>
                                            <button
                                              type="button"
                                              onClick={() => toggleReasoningExpansion(key)}
                                              className="cursor-pointer text-[11px] italic text-kumo-inactive transition-colors hover:text-kumo-subtle"
                                              aria-expanded={reasoningOpen}
                                            >
                                              {reasoningOpen ? "Hide reasoning" : "Show reasoning"}
                                            </button>
                                          </>
                                        )}
                                      </div>
                                    )}

                                    {msg.reasoning && reasoningOpen && (
                                      <div
                                        className={`mb-2 border-l border-kumo-line pl-3 text-[12px] leading-[18px] tracking-[-0.2px] ${styles.markdownContent} ${styles.reasoningMarkdown}`}
                                      >
                                        <MarkdownMessage message={msg.reasoning} />
                                      </div>
                                    )}
                                  </>
                                );
                              })()}

                              <div className={`text-[14px] leading-[21px] tracking-[-0.25px] text-kumo-default ${styles.markdownContent}`}>
                                <MarkdownMessage
                                  message={msg.message}
                                  capsules={msg.capsules}
                                />
                              </div>

                              {msg.toolCalls && msg.toolCalls.length > 0 && (
                                <div className="mt-1.5 space-y-1.5">
                                  {msg.toolCalls.map((tc, tcIdx) => {
                                    const open = expandedToolCalls.has(
                                      tc.toolCallId,
                                    );
                                    const summary = getToolCallSummary(tc);
                                    return (
                                      <div
                                        key={`${msg.chatId}-${msg.sequence}-tc-${tcIdx}`}
                                        className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base text-[13px] leading-[18px] tracking-[-0.25px]"
                                      >
                                        <button
                                          onClick={() =>
                                            toggleToolCallExpansion(
                                              tc.toolCallId,
                                            )
                                          }
                                          className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-kumo-tint/60"
                                        >
                                          <svg
                                            width="12"
                                            height="12"
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="2.5"
                                            className={`flex-shrink-0 transition-transform ${open ? "rotate-90" : ""} text-kumo-subtle`}
                                          >
                                            <polyline points="9 18 15 12 9 6" />
                                          </svg>
                                          <span className="rounded-full border border-kumo-line bg-kumo-tint px-2 py-0.5 text-[11px] leading-4 font-medium tracking-[-0.2px] text-kumo-subtle">
                                            Tool
                                          </span>
                                          <span className="min-w-0 flex flex-1 items-baseline gap-2 truncate">
                                            <span className="flex-shrink-0 font-mono text-[12px] text-kumo-default">
                                              {summary.verb}
                                            </span>
                                            {summary.target && (
                                              <span className="min-w-0 truncate font-mono text-[12px] text-kumo-subtle">
                                                {summary.target}
                                              </span>
                                            )}
                                          </span>
                                          {tc.error && (
                                            <span className="flex-shrink-0 rounded-full border border-kumo-danger/20 bg-kumo-danger-tint px-2 py-0.5 text-[10px] font-bold text-kumo-danger">
                                              ERROR
                                            </span>
                                          )}
                                        </button>
                                        {open && (
                                          <div className="space-y-2 border-t border-kumo-line bg-kumo-elevated px-3 py-3">
                                            {tc.error && (
                                              <pre className="rounded-lg border border-kumo-danger/20 bg-kumo-base p-2 font-mono text-[12px] leading-[18px] text-kumo-danger whitespace-pre-wrap">
                                                {tc.error}
                                              </pre>
                                            )}
                                            {tc.toolName === "executeCode" ? (
                                              <>
                                                <span className="font-mono text-[11px] leading-4 text-kumo-subtle uppercase tracking-[0.04em]">
                                                  Code
                                                </span>
                                                <pre className="max-h-48 overflow-auto rounded-lg border border-kumo-line bg-kumo-elevated p-2 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
                                                  {tc.input.code}
                                                </pre>
                                                {tc.output && (
                                                  <>
                                                    <span className="font-mono text-[11px] leading-4 text-kumo-subtle uppercase tracking-[0.04em]">
                                                      Output
                                                    </span>
                                                    <pre className="max-h-48 overflow-auto rounded-lg border border-kumo-line bg-kumo-elevated p-2 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
                                                      {tc.output}
                                                    </pre>
                                                  </>
                                                )}
                                              </>
                                            ) : (
                                              <pre className="max-h-48 overflow-auto rounded-lg border border-kumo-line bg-kumo-elevated p-2 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
                                                {JSON.stringify(
                                                  tc.input,
                                                  null,
                                                  2,
                                                )}
                                              </pre>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          </div>
                          )
                        )}

                        {msg.type === "changes" &&
                          (() => {
                            const status =
                              messageStates.changeStatus.get(msg.sequence) ??
                              "pending";
                            const dotClass = status === "merged"
                              ? "bg-kumo-success/70 border-kumo-success/70"
                              : status === "reverted"
                                ? "bg-transparent border-kumo-inactive"
                                : "bg-kumo-brand border-kumo-brand";
                            const labelText = status === "merged"
                              ? "Accepted"
                              : status === "reverted"
                                ? "Checkpoint discarded"
                                : "Checkpoint";
                            const labelClass = status === "reverted"
                              ? "text-kumo-inactive line-through"
                              : "text-kumo-subtle";
                            // When the checkpoint immediately follows a message from the same
                            // agent author, the assistant header right above already shows the
                            // author and timestamp. Suppress them on the checkpoint row to avoid
                            // redundancy. They remain visible for user-authored ("Save checkpoint")
                            // rows and detached agent checkpoints.
                            const showAuthorAndTime =
                              status === "pending" && !isAgentContinuation;
                            const authorChunk = showAuthorAndTime
                              ? msg.author.type === "user"
                                ? "You"
                                : msg.author.name
                              : null;
                            const timeText = msg.timestamp.toLocaleTimeString(
                              [],
                              { hour: "2-digit", minute: "2-digit" },
                            );
                            // Always include the time in the accessible label even when it's
                            // visually suppressed, so screen-reader users keep temporal context.
                            const ariaLabel = authorChunk
                              ? `${labelText} by ${authorChunk} at ${timeText}`
                              : `${labelText} at ${timeText}`;
                            return (
                              <div
                                className="group flex items-center gap-3 py-1.5 text-[12px] leading-4 tracking-[-0.2px]"
                                aria-label={ariaLabel}
                              >
                                <span
                                  className={`h-1.5 w-1.5 flex-shrink-0 rounded-full border ${dotClass}`}
                                  aria-hidden="true"
                                />
                                <span className={`flex-shrink-0 font-medium ${labelClass}`}>
                                  {labelText}
                                </span>
                                {authorChunk && (
                                  <>
                                    <span className="flex-shrink-0 text-kumo-inactive" aria-hidden="true">·</span>
                                    <span className="flex-shrink-0 truncate text-kumo-subtle">
                                      {authorChunk}
                                    </span>
                                  </>
                                )}
                                {showAuthorAndTime && (
                                  <Tooltip content={formatFullTimestamp(msg.timestamp)} asChild>
                                    <span className="font-mono text-[11px] text-kumo-inactive">
                                      {timeText}
                                    </span>
                                  </Tooltip>
                                )}
                                <span className="h-px flex-1 bg-kumo-line" aria-hidden="true" />
                                {status === "pending" && (
                                  <Tooltip content="Rewind to this checkpoint, discarding this and all later draft changes." asChild>
                                    <button
                                      type="button"
                                      disabled={isAgentActive}
                                      onClick={() =>
                                        handleRevertChanges(msg.sequence)
                                      }
                                      className="flex flex-shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-kumo-inactive transition-all hover:bg-kumo-tint hover:text-kumo-default focus-visible:bg-kumo-tint focus-visible:text-kumo-default group-hover:text-kumo-subtle disabled:cursor-not-allowed disabled:opacity-40"
                                      aria-label="Rewind to this checkpoint"
                                    >
                                      <ArrowCounterClockwise size={11} />
                                      Rewind
                                    </button>
                                  </Tooltip>
                                )}
                              </div>
                            );
                          })()}

                        {(msg.type === "merge" || msg.type === "revert") &&
                          (() => {
                            const isMerge = msg.type === "merge";
                            const ts = isMerge
                              ? messageStates.mergeTimestamps.get(msg.sequence)
                              : messageStates.revertTimestamps.get(
                                  msg.sequence,
                                );
                            return (
                              <div className="flex items-center gap-3 py-1.5 text-[12px] leading-4 tracking-[-0.2px]">
                                <span
                                  className={`h-1.5 w-1.5 flex-shrink-0 rounded-full border ${isMerge ? "border-kumo-success/70 bg-kumo-success/70" : "border-kumo-inactive bg-transparent"}`}
                                  aria-hidden="true"
                                />
                                <span className="flex-shrink-0 font-medium text-kumo-subtle">
                                  {msg.author.name}{" "}
                                  {isMerge
                                    ? `accepted through ${ts ? ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "earlier"}`
                                    : `rewound from ${ts ? ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "earlier"} onward`}
                                </span>
                                <Tooltip content={formatFullTimestamp(msg.timestamp)} asChild>
                                  <span className="font-mono text-[11px] text-kumo-inactive">
                                    {msg.timestamp.toLocaleTimeString([], {
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    })}
                                  </span>
                                </Tooltip>
                                <span className="h-px flex-1 bg-kumo-line" aria-hidden="true" />
                              </div>
                            );
                          })()}

                        {msg.type === "action" && renderActionCard(msg)}

                        {msg.type === "useGadget" && (
                          <div className="ml-10 max-w-[78%] flex items-center gap-2 rounded-xl border border-kumo-line bg-kumo-elevated px-3 py-2 text-[12px] leading-4 text-kumo-subtle">
                            <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-kumo-inactive" />
                            Agent used the Gadget
                            <Tooltip content={formatFullTimestamp(msg.timestamp)} asChild>
                              <span className="ml-auto font-mono text-[11px] text-kumo-inactive">
                                {msg.timestamp.toLocaleTimeString([], {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                              </span>
                            </Tooltip>
                          </div>
                        )}

                        {msg.type === "error" &&
                          (() => {
                            const key = `${msg.chatId}-${msg.sequence}`;
                            const isLast =
                              msg.sequence === lastMessageSequence &&
                              !isAgentActive;
                            const expanded = expandedErrors.has(key);
                            return (
                              <div
                                className={`ml-10 max-w-[78%] overflow-hidden rounded-xl border-l-2 text-[13px] leading-[18px] tracking-[-0.25px] ${
                                  isLast
                                    ? "border-l-kumo-danger border-y border-r border-y-kumo-line border-r-kumo-line bg-kumo-danger-tint/40"
                                    : "border-l-kumo-danger/50 border-y border-r border-y-kumo-line border-r-kumo-line bg-kumo-base"
                                }`}
                              >
                                <div
                                  role="button"
                                  tabIndex={0}
                                  onClick={() => toggleErrorExpansion(key)}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter" || event.key === " ") {
                                      event.preventDefault();
                                      toggleErrorExpansion(key);
                                    }
                                  }}
                                  className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-kumo-danger-tint/30 focus-visible:bg-kumo-danger-tint/30 focus-visible:outline-none"
                                  aria-expanded={expanded}
                                >
                                  <div className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                                  <span className="flex-shrink-0 rounded-full bg-kumo-danger/10 px-2 py-0.5 text-[11px] leading-4 font-medium tracking-[-0.2px] text-kumo-danger">
                                    Error
                                  </span>
                                  <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-kumo-subtle">
                                    {msg.message}
                                  </span>
                                  </div>
                                  {isLast && (
                                    <WorkshopButton
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        handleRetry();
                                      }}
                                      disabled={selectedModel === null}
                                      tone="secondary"
                                      className="!h-7 gap-1 text-[12px] text-kumo-default"
                                    >
                                      <ArrowsClockwise size={12} weight="bold" />
                                      Retry
                                    </WorkshopButton>
                                  )}
                                  <Tooltip content={formatFullTimestamp(msg.timestamp)} asChild>
                                    <span className="flex-shrink-0 font-mono text-[11px] text-kumo-inactive">
                                      {msg.timestamp.toLocaleTimeString([], {
                                        hour: "2-digit",
                                        minute: "2-digit",
                                      })}
                                    </span>
                                  </Tooltip>
                                </div>
                                {expanded && (
                                  <div className="border-t border-kumo-line px-3 py-2.5">
                                    <pre className="max-h-48 overflow-auto rounded-lg border border-kumo-line bg-kumo-base p-2.5 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
                                      {msg.message}
                                    </pre>
                                  </div>
                                )}
                              </div>
                            );
                          })()}

                        {msg.type === "agentCallback" && (
                          <div className="ml-10 max-w-[78%] overflow-hidden rounded-xl border border-[#d8c7f3] bg-[#f0eafa] px-3 py-2.5 text-[13px] leading-[18px] tracking-[-0.25px]">
                            <div className="mb-1 flex items-center gap-1.5 font-medium text-[#6f42c1]">
                              <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                              >
                                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                              </svg>
                              self.{msg.methodName}() callback
                            </div>
                            <pre className="max-h-24 overflow-auto font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
                              {msg.argsSummary}
                            </pre>
                          </div>
                        )}
                        </div>
                      );
                    })}

                    {currentDraftState && currentDraftState.entries.length > 0 && (() => {
                      const latestAuthor = currentDraftState.latestAuthor;
                      const isUserAuthored = latestAuthor?.type === "user";
                      const title = isUserAuthored
                        ? "Unsaved changes"
                        : "Draft changes in progress";
                      const description = isUserAuthored
                        ? "Your edits are still a live draft."
                        : `${latestAuthor?.name ?? "The agent"} is editing changes for this gadget.`;
                      return (
                        <div className="ml-10 max-w-[78%] rounded-xl border border-kumo-line bg-kumo-tint px-3 py-3 text-[13px] leading-[18px] tracking-[-0.25px] shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]">
                          <div className="flex items-start gap-2.5">
                            <span
                              className="relative mt-1.5 flex h-2 w-2 flex-shrink-0 items-center justify-center"
                              aria-hidden="true"
                            >
                              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-kumo-brand/40" />
                              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-kumo-brand" />
                            </span>
                            <div className="min-w-0 flex-1">
                              <span className="font-semibold text-kumo-default">
                                {title}
                              </span>
                              <p className="mt-0.5 text-[12px] leading-4 text-kumo-subtle">
                                {description}
                              </p>
                            </div>
                            {(() => {
                              // Outer condition asserts entries.length > 0, so last is defined.
                              const lastDraftEntry =
                                currentDraftState.entries[
                                  currentDraftState.entries.length - 1
                                ];
                              return (
                                <Tooltip
                                  content={formatFullTimestamp(lastDraftEntry.timestamp)}
                                  asChild
                                >
                                  <span className="flex-shrink-0 font-mono text-[11px] text-kumo-inactive">
                                    {lastDraftEntry.timestamp.toLocaleTimeString([], {
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    })}
                                  </span>
                                </Tooltip>
                              );
                            })()}
                          </div>
                          <div className="mt-3 flex flex-wrap justify-end gap-2">
                            <Tooltip content="Throw away these draft edits." asChild>
                              <WorkshopButton
                                disabled={isAgentActive}
                                onClick={handleDiscardDraftChanges}
                                className="!h-8 text-kumo-danger hover:bg-kumo-danger-tint"
                              >
                                Discard changes
                              </WorkshopButton>
                            </Tooltip>
                            <Tooltip content="Save these edits as a checkpoint. They won't affect the gadget until you accept changes." asChild>
                              <WorkshopButton
                                disabled={isAgentActive}
                                onClick={handleFinalizeDraftChanges}
                                tone="primary"
                                className="!h-8"
                              >
                                Save checkpoint
                              </WorkshopButton>
                            </Tooltip>
                          </div>
                        </div>
                      );
                    })()}

                    {isAgentActive && activeAgent && (() => {
                      const lastDisplayEntry =
                        displayEntries.length > 0
                          ? displayEntries[displayEntries.length - 1]
                          : null;
                      const lastMessage =
                        lastDisplayEntry && lastDisplayEntry.type === "message"
                          ? lastDisplayEntry.message
                          : null;
                      const isStreamContinuation =
                        lastMessage?.type === "message" &&
                        lastMessage.author.type === "agent" &&
                        lastMessage.author.id === activeAgent.id;
                      const messageKey = `stream-${selectedChatId}`;
                      const reasoningOpen =
                        expandedReasoning.get(messageKey) ??
                        reasoningExpandedByDefault;
                      const hasContent = hasVisibleProvisionalContent && currentProvisionalState;
                      return (
                        <div className="flex items-start gap-3">
                          {isStreamContinuation ? (
                            <div className="w-7 flex-shrink-0" aria-hidden="true" />
                          ) : (
                            <AssistantAvatar />
                          )}
                          <div className="min-w-0 w-full max-w-[78%] space-y-1.5 py-0.5">
                            {!isStreamContinuation && (
                              <div className="mb-1.5 flex items-center gap-2">
                                <span className="text-[12px] leading-4 font-semibold tracking-[-0.2px] text-kumo-default">
                                  {activeAgent.name}
                                </span>
                                <span className="font-mono text-[11px] text-kumo-inactive">
                                  Working...
                                </span>
                                {hasContent && currentProvisionalState.reasoning && (
                                  <>
                                    <span className="text-[11px] text-kumo-inactive" aria-hidden="true">·</span>
                                    <button
                                      type="button"
                                      onClick={() => toggleReasoningExpansion(messageKey)}
                                      className="cursor-pointer text-[11px] italic text-kumo-inactive transition-colors hover:text-kumo-subtle"
                                      aria-expanded={reasoningOpen}
                                    >
                                      {reasoningOpen ? "Hide reasoning" : "Show reasoning"}
                                    </button>
                                  </>
                                )}
                              </div>
                            )}

                            {hasContent ? (
                              <>
                                {currentProvisionalState.reasoning && reasoningOpen && (
                                  <div className={`mb-2 border-l border-kumo-line pl-3 text-[12px] leading-[18px] tracking-[-0.2px] ${styles.markdownContent} ${styles.reasoningMarkdown}`}>
                                    <StreamingMarkdownMessage message={currentProvisionalState.reasoning} />
                                  </div>
                                )}

                                {currentProvisionalState.text && (
                                  <div className={`text-[14px] leading-[21px] tracking-[-0.25px] text-kumo-default ${styles.markdownContent}`}>
                                    <StreamingMarkdownMessage message={currentProvisionalState.text} />
                                  </div>
                                )}

                                {provisionalToolCalls.length > 0 && (
                                  <div className="mt-1.5 space-y-1.5">
                                    {provisionalToolCalls.map((toolCall) => {
                                      const isExpanded = expandedToolCalls.has(toolCall.toolCallId);
                                      return (
                                        <div
                                          key={`stream-tool-${toolCall.toolCallId}`}
                                          className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base text-[13px] leading-[18px] tracking-[-0.25px]"
                                        >
                                          <button
                                            onClick={() => toggleToolCallExpansion(toolCall.toolCallId)}
                                            className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-kumo-tint/60"
                                          >
                                            <svg
                                              width="12"
                                              height="12"
                                              viewBox="0 0 24 24"
                                              fill="none"
                                              stroke="currentColor"
                                              strokeWidth="2.5"
                                              className={`flex-shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""} text-kumo-subtle`}
                                            >
                                              <polyline points="9 18 15 12 9 6" />
                                            </svg>
                                            <span className="rounded-full border border-kumo-line bg-kumo-tint px-2 py-0.5 text-[11px] leading-4 font-medium tracking-[-0.2px] text-kumo-subtle">
                                              Tool
                                            </span>
                                            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-kumo-default">
                                              {toolCall.toolName ?? "tool"}
                                            </span>
                                            {!toolCall.finished && (
                                              <span className="flex-shrink-0 text-kumo-brand">
                                                <span className="block h-3 w-3 rounded-full border border-kumo-brand border-t-transparent animate-spin" />
                                              </span>
                                            )}
                                          </button>
                                          {isExpanded && (toolCall.code || toolCall.output) && (
                                            <div className="space-y-2 border-t border-kumo-line bg-kumo-elevated px-3 py-3">
                                              {toolCall.code && (
                                                <>
                                                  <span className="font-mono text-[11px] leading-4 text-kumo-subtle uppercase tracking-[0.04em]">Code</span>
                                                  <pre className="max-h-48 overflow-auto rounded-lg border border-kumo-line bg-kumo-base p-2 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
                                                    {toolCall.code}
                                                  </pre>
                                                </>
                                              )}
                                              {toolCall.output && (
                                                <>
                                                  <span className="font-mono text-[11px] leading-4 text-kumo-subtle uppercase tracking-[0.04em]">Output</span>
                                                  <pre className="max-h-48 overflow-auto rounded-lg border border-kumo-line bg-kumo-base p-2 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
                                                    {toolCall.output}
                                                  </pre>
                                                </>
                                              )}
                                            </div>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}

                                {!hasRunningProvisionalToolCall && (
                                  <div className="mt-2 flex items-center gap-2">
                                    <span className="block h-3 w-3 rounded-full border-2 border-kumo-brand border-t-transparent animate-spin" />
                                  </div>
                                )}
                              </>
                            ) : (
                              <div className="flex items-center gap-1">
                                <span className="h-1.5 w-1.5 rounded-full bg-kumo-brand animate-bounce [animation-delay:0ms]" />
                                <span className="h-1.5 w-1.5 rounded-full bg-kumo-brand animate-bounce [animation-delay:150ms]" />
                                <span className="h-1.5 w-1.5 rounded-full bg-kumo-brand animate-bounce [animation-delay:300ms]" />
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>

              {/* ── Bottom: input, update state, and cost ──────────────── */}
              <div className={`flex-shrink-0 bg-kumo-base ${sidebarMode ? "" : "border-t border-kumo-line"}`}>
                <div className={useConstrainedChatWidth ? "mx-auto w-full max-w-[760px]" : ""}>
                  <ChatInput
                    createCapsuleGatekeeper={(accountId, url) =>
                      overseer.newGatekeeper(accountId, url)
                    }
                    getOverseer={() => overseer}
                    onSend={handleSend}
                    isAgentActive={isAgentActive}
                    models={availableModels}
                    selectedModel={selectedModel}
                    onModelChange={handleModelChange}
                    pendingConsoleLogCount={pendingConsoleLogCount}
                    consoleLogPreview={consoleLogPreview}
                    consoleLogSeverity={consoleLogSeverity}
                    onConsumeConsoleLogs={onConsumeConsoleLogs}
                    onDiscardConsoleLogs={onDiscardConsoleLogs}
                    onStop={handleStop}
                    draftUpdateBanner={(() => {
                      if (
                        !currentChatMetadata?.hasProposedChanges ||
                        isAgentActive
                      )
                        return null;

                      const { activeChanges } = messageStates;
                      if (activeChanges.length === 0) return null;
                      const lastActiveChange = lastDurablePendingChange;
                      if (!lastActiveChange) return null;
                      return (
                        <div className="relative flex items-center gap-3 overflow-hidden rounded-t-[calc(1rem-1px)] border-b border-kumo-line bg-kumo-elevated px-3.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)]">
                          <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-kumo-brand/40 to-transparent" aria-hidden="true" />
                          <Tooltip content="Accept changes to apply them to the gadget." asChild>
                            <span className="min-w-0 flex-1 truncate text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
                              Accept changes to apply them to the gadget.
                            </span>
                          </Tooltip>
                          <Tooltip content="Accept the current draft update and apply it to your gadget." asChild>
                            <WorkshopButton
                              onClick={() =>
                                handleMergeChanges(lastActiveChange.sequence, {
                                  includeDraft: true,
                                })
                              }
                              tone="primary"
                              className="!h-7 gap-1 text-[12px]"
                            >
                              <svg
                                width="10"
                                height="10"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                              >
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                              Accept changes
                            </WorkshopButton>
                          </Tooltip>
                        </div>
                      );
                    })()}
                  />

                  {/* Token / cost summary */}
                  {(currentChatMetadata?.totalTokens != null ||
                    currentChatMetadata?.totalCost != null) && (
                    <div className="flex items-center justify-end gap-4 px-4 pb-2 font-mono text-[11px] text-kumo-inactive">
                      {currentChatMetadata.totalTokens != null && (
                        <span>
                          {currentChatMetadata.totalTokens.toLocaleString()}{" "}
                          tokens
                        </span>
                      )}
                      {currentChatMetadata.totalCost != null && (
                        <span>${currentChatMetadata.totalCost.toFixed(4)}</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      ) : null}

      <DeleteConfirmationDialog
        open={deleteTarget !== null}
        title="Delete conversation?"
        description={<>This removes <span className="font-medium text-kumo-default">{deleteTarget?.title}</span>. You can&apos;t undo this.</>}
        isDeleting={isDeleting}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onConfirm={handleDeleteConfirm}
      />
    </div>
  );
}

export default ChatInterface;
