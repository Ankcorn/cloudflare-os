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
  Tooltip,
  useKumoToastManager,
} from "@cloudflare/kumo";

import {
  CaretDown,
  CaretLeft,
  CaretRight,
  Check,
  X,
  Pencil,
  Trash,
  DotsThreeVertical,
  LinkSimple,
  Plug,
  Plus,
  Swap,
  ArrowUUpLeft,
  ArrowsClockwise,
  Copy,
  WarningCircle,
  Code,
  File as FileIcon,
  PencilSimple,
  Brain,
  Terminal,
  Globe,
  MagnifyingGlass,
  Question,
} from "@phosphor-icons/react";
import { RpcStub, RpcTarget } from "capnweb";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import * as Y from "yjs";
import styles from "./ChatInterface.module.css";
import {
  getStoredSelectedModel,
  persistSelectedModel,
} from "./modelSelection";
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
import { copyToClipboard } from "./clipboard";

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

type ChatListScope = "direct" | "agents" | "all";

const CHAT_LIST_SCOPE_LABELS: Record<ChatListScope, string> = {
  all: "All conversations",
  direct: "Direct conversations",
  agents: "Agent runs",
};

const SHOW_THINKING_TRACES_KEY = "showThinkingTraces";

function getStoredShowThinkingTraces(): boolean {
  try {
    // Clean up the key this setting replaced.
    window.localStorage.removeItem("expandReasoningByDefault");
    return window.localStorage.getItem(SHOW_THINKING_TRACES_KEY) !== "false";
  } catch {
    return true;
  }
}

function persistShowThinkingTraces(show: boolean): void {
  try {
    window.localStorage.setItem(SHOW_THINKING_TRACES_KEY, show ? "true" : "false");
  } catch {
    // private mode / sandboxed iframes
  }
}

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

// Convert raw tool calls into user-facing transcript labels.
function getToolCallSummary(tc: AiToolCall): { verb: string; target?: string } {
  switch (tc.toolName) {
    case "readFile":
      return { verb: "Read", target: tc.input.filename };
    case "writeFile":
      return { verb: "Wrote", target: tc.input.filename };
    case "editFile":
      return { verb: "Edited", target: tc.input.filename };
    case "describeBinding":
      return { verb: "Inspected", target: `${String(tc.input.name)} binding` };
    case "setBindingHook":
      return {
        verb: "Connected",
        target: tc.input.entrypoint
          ? `${tc.input.bindingName} → ${tc.input.entrypoint}`
          : tc.input.bindingName,
      };
    case "saveCapsuleAsBinding":
      return { verb: "Saved resource", target: tc.input.bindingName };
    case "executeCode": {
      // Prefer the first non-empty line as a preview.
      const firstLine = tc.input.code
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      return {
        verb: "Ran code",
        target: firstLine
          ? firstLine.length > 60
            ? `${firstLine.slice(0, 57)}…`
            : firstLine
          : undefined,
      };
    }
    case "giveUp":
      return { verb: "Stopped" };
    case "webFetch": {
      let target = tc.input.url;
      try {
        target = new URL(tc.input.url).host;
      } catch {
        // Leave as the raw URL.
      }
      return { verb: "Fetched", target };
    }
    case "observeUserChanges":
      return { verb: "Observed user changes" };
  }
  // Compile-time exhaustiveness check.
  const _exhaustive: never = tc;
  return { verb: (_exhaustive as { toolName: string }).toolName };
}

type PhosphorIcon = typeof MagnifyingGlass;

type ActionChatMessage = Extract<AiChatMessage, { type: "action" }>;
type ChangeChatMessage = Extract<AiChatMessage, { type: "changes" }>;
type PendingTurnChanges = {
  revertFrom: number;
  through: number;
};
type ObservationChatMessage = ActionChatMessage & {
  actionLog: NonNullable<ActionChatMessage["actionLog"]> & { type: "observation" };
};

type ToolCallGroup = {
  key: string;
  Icon: PhosphorIcon;
  label: string;
  detailLines: string[];
  calls: AiToolCall[];
  observations: ObservationChatMessage[];
  hasError: boolean;
};

function lowerFirst(text: string): string {
  return text ? text[0].toLowerCase() + text.slice(1) : text;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatTimes(count: number): string {
  return pluralize(count, "time");
}

function describeObservationCount(count: number): string {
  return count === 1 ? "Read 1 resource" : `${count} resource reads`;
}

function describeToolCallCount(toolName: AiToolCall["toolName"], count: number): string {
  switch (toolName) {
    case "readFile":
      return `Read ${pluralize(count, "file")}`;
    case "writeFile":
      return `Wrote ${pluralize(count, "file")}`;
    case "editFile":
      return count === 1 ? "Made 1 edit" : `Made ${count} edits`;
    case "webFetch":
      return `Fetched ${pluralize(count, "page")}`;
    case "executeCode":
      return count === 1 ? "Ran code" : `Ran code ${formatTimes(count)}`;
    case "describeBinding":
      return `Inspected ${pluralize(count, "binding")}`;
    case "setBindingHook":
      return `Connected ${pluralize(count, "binding")}`;
    case "saveCapsuleAsBinding":
      return `Saved ${pluralize(count, "resource")}`;
    case "observeUserChanges":
      return `Observed ${pluralize(count, "change set")}`;
    case "giveUp":
      return count === 1 ? "Stopped" : `Stopped ${count} times`;
  }
  const _exhaustive: never = toolName;
  return _exhaustive;
}

function getToolIcon(toolName: AiToolCall["toolName"] | null | undefined): PhosphorIcon {
  switch (toolName) {
    case "readFile":
    case "writeFile":
      return FileIcon;
    case "editFile":
      return PencilSimple;
    case "executeCode":
      return Terminal;
    case "webFetch":
      return Globe;
    case "describeBinding":
      return MagnifyingGlass;
    case "setBindingHook":
    case "saveCapsuleAsBinding":
      return LinkSimple;
    case "observeUserChanges":
      return MagnifyingGlass;
    case "giveUp":
      return Question;
    default:
      return Question;
  }
}

function getProvisionalToolLabel(toolName: AiToolCall["toolName"] | null | undefined) {
  switch (toolName) {
    case "readFile":
      return "Reading file";
    case "writeFile":
      return "Writing file";
    case "editFile":
      return "Editing file";
    case "describeBinding":
      return "Inspecting binding";
    case "setBindingHook":
      return "Connecting binding";
    case "saveCapsuleAsBinding":
      return "Saving resource";
    case "executeCode":
      return "Running code";
    case "webFetch":
      return "Fetching web page";
    case "observeUserChanges":
      return "Observing user changes";
    case "giveUp":
      return "Stopping";
    default:
      return "Using tool";
  }
}

function getToolTarget(tc: AiToolCall): string | undefined {
  return getToolCallSummary(tc).target;
}

// Present-tense verb for an in-progress tool call.
function getProvisionalToolVerb(toolName: AiToolCall["toolName"]): string {
  switch (toolName) {
    case "readFile": return "Reading";
    case "writeFile": return "Writing";
    case "editFile": return "Editing";
    case "describeBinding": return "Inspecting";
    case "setBindingHook": return "Connecting";
    case "saveCapsuleAsBinding": return "Saving resource";
    case "executeCode": return "Running code";
    case "webFetch": return "Fetching";
    case "observeUserChanges": return "Observing user changes";
    case "giveUp": return "Stopping";
  }
  const _exhaustive: never = toolName;
  return _exhaustive;
}

// Present-tense, count-aware label mirroring describeToolCallCount (e.g. "Writing 5 files").
function describeProvisionalToolCount(toolName: AiToolCall["toolName"], count: number): string {
  if (count <= 1) return getProvisionalToolLabel(toolName);
  switch (toolName) {
    case "readFile": return `Reading ${pluralize(count, "file")}`;
    case "writeFile": return `Writing ${pluralize(count, "file")}`;
    case "editFile": return `Making ${count} edits`;
    case "webFetch": return `Fetching ${pluralize(count, "page")}`;
    case "executeCode": return count === 1 ? "Running code" : `Running code ${formatTimes(count)}`;
    case "describeBinding": return `Inspecting ${pluralize(count, "binding")}`;
    case "setBindingHook": return `Connecting ${pluralize(count, "binding")}`;
    case "saveCapsuleAsBinding": return `Saving ${pluralize(count, "resource")}`;
    case "observeUserChanges": return `Observing ${pluralize(count, "change set")}`;
    case "giveUp": return "Stopping";
  }
  const _exhaustive: never = toolName;
  return _exhaustive;
}

// Builds the label + detail lines for the in-progress tool-call row.
function buildProvisionalToolSummary(
  calls: ProvisionalToolCallState[],
): { label: string; detailLines: string[] } {
  const toolNames = Array.from(
    new Set(calls.map((c) => c.toolName).filter((n): n is AiToolCall["toolName"] => !!n)),
  );
  const detailLines = Array.from(
    new Set(calls.map((c) => c.target).filter((t): t is string => Boolean(t))),
  );

  if (toolNames.length === 0) {
    return { label: "Using tool", detailLines: [] };
  }

  if (toolNames.length > 1) {
    const parts = toolNames.map((toolName) =>
      describeProvisionalToolCount(
        toolName,
        calls.filter((c) => c.toolName === toolName).length,
      ),
    );
    return {
      label: parts.map((part, i) => (i === 0 ? part : lowerFirst(part))).join(", "),
      detailLines,
    };
  }

  const toolName = toolNames[0];
  if (calls.length === 1) {
    const target = detailLines[0];
    return {
      label: target ? `${getProvisionalToolVerb(toolName)} ${target}` : getProvisionalToolLabel(toolName),
      detailLines: [],
    };
  }

  const label =
    detailLines.length === 1
      ? `${getProvisionalToolVerb(toolName)} ${detailLines[0]}`
      : describeProvisionalToolCount(toolName, calls.length);
  return { label, detailLines };
}

function buildToolCallGroups(
  toolCalls: AiToolCall[],
  observations: ObservationChatMessage[] = [],
): ToolCallGroup[] {
  if (toolCalls.length === 0 && observations.length === 0) return [];

  const distinctToolNames = Array.from(new Set(toolCalls.map((tc) => tc.toolName)));
  const targets = toolCalls
    .map((tc) => getToolTarget(tc))
    .filter((target): target is string => Boolean(target));
  const observationTargets = observations
    .map((msg) => msg.actionLog.resourceTitle)
    .filter((target): target is string => Boolean(target));
  const detailLines = Array.from(new Set([...targets, ...observationTargets]));
  const labelParts: string[] = [];

  if (toolCalls.length === 1) {
    const summary = getToolCallSummary(toolCalls[0]);
    labelParts.push(`${summary.verb}${summary.target ? ` ${summary.target}` : ""}`);
  } else if (toolCalls.length > 1 && distinctToolNames.length === 1) {
    const summary = getToolCallSummary(toolCalls[0]);
    labelParts.push(detailLines.length === 1 && summary.target && observations.length === 0
      ? `${summary.verb} ${summary.target}`
      : describeToolCallCount(toolCalls[0].toolName, toolCalls.length));
  } else if (toolCalls.length > 1 && distinctToolNames.length <= 3) {
    labelParts.push(...distinctToolNames.map((toolName) => {
      const count = toolCalls.filter((tc) => tc.toolName === toolName).length;
      return describeToolCallCount(toolName, count);
    }));
  } else if (toolCalls.length > 0) {
    labelParts.push(`${toolCalls.length} tool calls`);
  }

  if (observations.length > 0) {
    labelParts.push(describeObservationCount(observations.length));
  }

  const firstToolCall = toolCalls[0];
  const firstObservation = observations[0];

  return [{
    // Use the first work item id so expansion survives streaming → committed.
    key: firstToolCall
      ? `group-${firstToolCall.toolCallId}`
      : `group-observation-${firstObservation.chatId}-${firstObservation.sequence}`,
    Icon: firstToolCall ? getToolIcon(firstToolCall.toolName) : MagnifyingGlass,
    label: labelParts
      .map((part, index) => index === 0 ? part : lowerFirst(part))
      .join(", "),
    detailLines,
    calls: toolCalls,
    observations,
    hasError: toolCalls.some((tc) => Boolean(tc.error)),
  }];
}

function WorkIcon({ Icon }: { Icon: PhosphorIcon }) {
  return <Icon size={15} className="text-kumo-inactive" />;
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

const ToolCallDetails = memo(function ToolCallDetails(
  { toolCall: tc }: { toolCall: AiToolCall },
) {
  return (
    <div className="space-y-2">
      {tc.error && (
        <pre className="rounded-xl border border-kumo-danger/20 bg-kumo-danger-tint/40 p-3 font-mono text-[12px] leading-[18px] text-kumo-danger whitespace-pre-wrap">
          {tc.error}
        </pre>
      )}
      {tc.toolName === "executeCode" ? (
        <>
          <span className="font-mono text-[11px] leading-4 text-kumo-inactive uppercase tracking-[0.08em]">
            Code
          </span>
          <pre className="max-h-56 overflow-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
            {tc.input.code}
          </pre>
          {tc.output && (
            <>
              <span className="font-mono text-[11px] leading-4 text-kumo-inactive uppercase tracking-[0.08em]">
                Output
              </span>
              <pre className="max-h-56 overflow-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
                {tc.output}
              </pre>
            </>
          )}
        </>
      ) : (
        <pre className="max-h-56 overflow-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
          {JSON.stringify(tc.input, null, 2)}
        </pre>
      )}
    </div>
  );
});

const ObservationDetails = memo(function ObservationDetails(
  { observation }: { observation: ObservationChatMessage },
) {
  const log = observation.actionLog;
  const safeResourceUrl = getSafeExternalUrl(log.resourceUrl);
  const metadata = [log.resourceTitle, log.bindingName].filter(Boolean).join(" · ");

  return (
    <div className="px-1 py-1.5 text-[13px] leading-[19px] tracking-[-0.25px]">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center">
          <WorkIcon Icon={MagnifyingGlass} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="m-0 font-medium text-kumo-default">
            {log.description.title}
          </p>
          {metadata && (
            <p className="mt-0.5 mb-0 truncate text-[12px] leading-4 text-kumo-inactive">
              {safeResourceUrl && log.resourceTitle ? (
                <a
                  href={safeResourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  {metadata}
                </a>
              ) : metadata}
            </p>
          )}
          <div className="mt-1.5 text-[12px] leading-[18px] tracking-[-0.2px] text-kumo-subtle">
            <MarkdownMessage message={log.description.description} />
          </div>
        </div>
      </div>
    </div>
  );
});

const NestedToolCallRow = memo(function NestedToolCallRow({
  toolCall: tc,
  open,
  onToggle,
}: {
  toolCall: AiToolCall;
  open: boolean;
  onToggle: (key: string) => void;
}) {
  const key = `call-${tc.toolCallId}`;
  const summary = getToolCallSummary(tc);
  const label = `${summary.verb}${summary.target ? ` ${summary.target}` : ""}`;
  const Icon = getToolIcon(tc.toolName);

  return (
    <div className="group/nested">
      <button
        type="button"
        onClick={() => onToggle(key)}
        className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-1.5 py-1 text-left text-kumo-subtle transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.995]"
        aria-expanded={open}
      >
        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
          <WorkIcon Icon={Icon} />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2 text-[14px] leading-5 tracking-[-0.25px]">
          <span className="min-w-0 truncate">{label}</span>
          {tc.error && (
            <span className="flex-shrink-0 rounded-full bg-kumo-danger-tint px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.04em] text-kumo-danger">
              Error
            </span>
          )}
          <CaretRight
            size={13}
            weight="bold"
            className={`flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out ${open ? "rotate-90" : ""}`}
          />
        </span>
      </button>
      {open && (
        <div className="ml-8 mt-1 space-y-3 rounded-2xl border border-kumo-line/70 bg-kumo-elevated/45 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]">
          <ToolCallDetails toolCall={tc} />
        </div>
      )}
    </div>
  );
});

const NestedObservationRow = memo(function NestedObservationRow({
  observation,
  open,
  onToggle,
}: {
  observation: ObservationChatMessage;
  open: boolean;
  onToggle: (key: string) => void;
}) {
  const key = `observation-${observation.chatId}-${observation.sequence}`;
  const log = observation.actionLog;
  const label = `Read ${log.description.title || log.resourceTitle || "resource"}`;

  return (
    <div className="group/nested">
      <button
        type="button"
        onClick={() => onToggle(key)}
        className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-1.5 py-1 text-left text-kumo-subtle transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.995]"
        aria-expanded={open}
      >
        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
          <WorkIcon Icon={MagnifyingGlass} />
        </span>
        <span className="inline-flex min-w-0 max-w-full items-center gap-2 text-[14px] leading-5 tracking-[-0.25px]">
          <span className="min-w-0 truncate">{label}</span>
          <CaretRight
            size={13}
            weight="bold"
            className={`flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out ${open ? "rotate-90" : ""}`}
          />
        </span>
      </button>
      {open && (
        <div className="ml-8 mt-1 space-y-3 rounded-2xl border border-kumo-line/70 bg-kumo-elevated/45 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]">
          <ObservationDetails observation={observation} />
        </div>
      )}
    </div>
  );
});

const ThinkingTraceRow = memo(function ThinkingTraceRow({
  reasoning,
}: {
  reasoning: string;
}) {
  return (
    <div className="min-w-0 py-1 text-kumo-subtle">
      <div className={`min-w-0 text-[13px] leading-[19px] ${styles.markdownContent}`}>
        <MarkdownMessage message={reasoning} />
      </div>
    </div>
  );
});

const ToolGroupRow = memo(function ToolGroupRow({
  group,
  open,
  expandedKeys,
  onToggle,
  footerChangeSequence,
  footerTimestamp,
  footerIsTrailing,
  footerDisabled = false,
  onFooterRevert,
}: {
  group: ToolCallGroup;
  open: boolean;
  expandedKeys: ReadonlySet<string>;
  onToggle: (key: string) => void;
  footerChangeSequence?: number;
  footerTimestamp?: Date;
  footerIsTrailing?: boolean;
  footerDisabled?: boolean;
  onFooterRevert?: (sequence: number) => void;
}) {
  const footerLabel = footerChangeSequence !== undefined
    ? getDiscardLabel(footerIsTrailing)
    : null;
  return (
    <div className="group -ml-0.5">
      <button
        type="button"
        onClick={() => onToggle(group.key)}
        className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-1.5 py-1 text-left text-kumo-subtle transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.995]"
        aria-expanded={open}
      >
        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
          <WorkIcon Icon={group.Icon} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2 text-[14px] leading-5 tracking-[-0.25px]">
            <span className="min-w-0 truncate">{group.label}</span>
            {group.hasError && (
              <span className="flex-shrink-0 rounded-full bg-kumo-danger-tint px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.04em] text-kumo-danger">
                Error
              </span>
            )}
            <CaretRight
              size={13}
              weight="bold"
              className={`flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out ${open ? "rotate-90" : ""}`}
            />
          </span>
          {group.detailLines.length > 1 && (
            <span className="mt-1 block truncate font-mono text-[12px] leading-4 text-kumo-inactive">
              {group.detailLines.join(" · ")}
            </span>
          )}
        </span>
      </button>
      {open && (
        group.calls.length === 1 && group.observations.length === 0 ? (
          <div className="ml-8 mt-1 space-y-3 rounded-2xl border border-kumo-line/70 bg-kumo-elevated/45 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]">
            <ToolCallDetails toolCall={group.calls[0]} />
          </div>
        ) : group.calls.length === 0 && group.observations.length === 1 ? (
          <div className="ml-8 mt-1 space-y-3 rounded-2xl border border-kumo-line/70 bg-kumo-elevated/45 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]">
            <ObservationDetails observation={group.observations[0]} />
          </div>
        ) : (
          <div className="ml-8 mt-1 space-y-1">
            {group.calls.map((toolCall) => {
              const key = `call-${toolCall.toolCallId}`;
              return (
                <NestedToolCallRow
                  key={toolCall.toolCallId}
                  toolCall={toolCall}
                  open={expandedKeys.has(key)}
                  onToggle={onToggle}
                />
              );
            })}
            {group.observations.map((observation) => {
              const key = `observation-${observation.chatId}-${observation.sequence}`;
              return (
                <NestedObservationRow
                  key={key}
                  observation={observation}
                  open={expandedKeys.has(key)}
                  onToggle={onToggle}
                />
              );
            })}
          </div>
        )
      )}
      {footerChangeSequence !== undefined && footerTimestamp && footerLabel && onFooterRevert && (
        <div className="ml-0 mt-0.5 flex items-center gap-1 opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100 group-focus-within:opacity-100">
          <Tooltip content={footerLabel} asChild>
            <button
              type="button"
              disabled={footerDisabled}
              onClick={() => onFooterRevert(footerChangeSequence)}
              className="flex cursor-pointer items-center rounded-md p-1 text-kumo-inactive transition-[color,opacity,transform] duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={footerLabel}
            >
              <ArrowUUpLeft size={15} />
            </button>
          </Tooltip>
          <Tooltip content={formatFullTimestamp(footerTimestamp)} asChild>
            <span className="px-1 font-mono text-[11px] leading-4 text-kumo-inactive">
              {footerTimestamp.toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </Tooltip>
        </div>
      )}
    </div>
  );
});

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
  minRows = 2,
  attachLabel,
  draftUpdateBanner,
  onStop,
  showThinkingTraces = true,
  onToggleThinkingTraces,
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
  /** Minimum number of textarea rows at rest. Defaults to 2. */
  minRows?: number;
  /** Optional label for the attach menu item. */
  attachLabel?: string;
  draftUpdateBanner?: ReactNode;
  onStop?: () => void;
  showThinkingTraces?: boolean;
  onToggleThinkingTraces?: () => void;
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

  // Insert a capsule chip at the given position and move the caret past it.
  const insertCapsuleAt = (
    insertPos: number,
    id: number,
    description: ResourceDescription,
  ) => {
    // Pad the title with spaces so the mirror highlight has visible interior padding.
    const paddedTitle = ` ${description.title} `;

    setInputValue(
      (prev) => prev.slice(0, insertPos) + paddedTitle + prev.slice(insertPos),
    );

    // Shift any existing capsules after the insertion point.
    setCapsules((prev) => {
      const adjusted = prev.map((c) =>
        c.start >= insertPos ? { ...c, start: c.start + paddedTitle.length } : c,
      );
      return [
        ...adjusted,
        { start: insertPos, length: paddedTitle.length, gatekeeperId: id, description },
      ];
    });

    requestAnimationFrame(() => {
      const textarea = wrapperRef.current?.querySelector("textarea");
      if (textarea) {
        const cursorPos = insertPos + paddedTitle.length;
        textarea.setSelectionRange(cursorPos, cursorPos);
        textarea.focus();
      }
    });
  };

  // Called by the GatekeeperModal when a gatekeeper is created via the attach flow.
  // Inserts a capsule at the previously-saved cursor position.
  const handleAttachCreated = async (gk: RpcStub<GatekeeperClient<any>>) => {
    try {
      // Fetch ID and description in parallel (promise pipelining).
      const [id, description] = await Promise.all([gk.getId(), gk.describe()]);
      insertCapsuleAt(attachCursorPosRef.current, id, description);
      setAttachModalOpen(false);
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
  const selectedModelLabel = selectedModel == null
    ? "No agent"
    : models.find((model) => model.id === selectedModel)?.name ?? selectedModel;

  return (
    // isolation: isolate contains z-indexes used inside the composer (the
    // captured-log floating chip with z-10, the textarea/mirror with z-[1])
    // so they can't paint on top of body-level portaled popovers like the
    // model picker dropdown opening above the composer.
    <div className={`px-4 py-4 relative isolate ${styles.chatInputRoot}`}>
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
                type="button"
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
              type="button"
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
        <div className="relative px-4 pb-1 pt-3">
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
                autoResizeTextarea(e.target, minRows, newChat ? 10 : 4);
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
              rows={minRows}
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
                if (el) autoResizeTextarea(el, minRows, newChat ? 10 : 4);
              }}
              className="relative z-[1] w-full resize-none border-none bg-transparent p-0 text-[14px] leading-5 tracking-[-0.25px] text-kumo-default outline-none placeholder:text-kumo-inactive disabled:cursor-not-allowed disabled:text-kumo-inactive"
            />
          </div>
        </div>

        {/* Footer row: connection/options left, model + send right */}
        <div className="flex items-center justify-between gap-1.5 px-3 pb-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
            {onToggleThinkingTraces && (
              <DropdownMenu>
                <DropdownMenu.Trigger
                  render={
                    <button
                      type="button"
                      className="group flex h-8 w-8 flex-shrink-0 cursor-pointer items-center justify-center rounded-lg text-kumo-inactive transition-[background-color,color,transform] duration-150 ease-out hover:bg-kumo-tint hover:text-kumo-subtle focus-visible:bg-kumo-tint focus-visible:text-kumo-subtle focus-visible:outline-none active:scale-[0.96] data-[popup-open]:bg-kumo-tint data-[popup-open]:text-kumo-subtle"
                      aria-label="Open chat options"
                    >
                      <Plus size={18} />
                    </button>
                  }
                />
                <DropdownMenu.Content collisionPadding={16} className="!z-[1100] !min-w-[170px] rounded-2xl border border-kumo-line/70 bg-kumo-base p-1 shadow-[0_14px_36px_rgba(82,16,0,0.10)]">
                  <DropdownMenu.Item
                    onClick={onToggleThinkingTraces}
                    className="!h-auto rounded-xl !px-2 !py-1.5 text-[12px] leading-4 font-normal tracking-[-0.15px] text-kumo-subtle transition-colors data-highlighted:bg-kumo-tint/70 data-highlighted:text-kumo-default"
                  >
                    <span className="mr-2 inline-flex h-4 w-4 items-center justify-center text-kumo-inactive">
                      <Brain size={14} />
                    </span>
                    <span className="flex-1">
                      {showThinkingTraces ? "Hide thinking" : "Show thinking"}
                    </span>
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu>
            )}
            <button
              type="button"
              onClick={handleAttachOpen}
              className="inline-flex h-8 flex-shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[13px] leading-none tracking-[-0.25px] text-kumo-inactive transition-[background-color,color,transform] duration-150 ease-out hover:bg-kumo-tint hover:text-kumo-subtle focus-visible:bg-kumo-tint focus-visible:text-kumo-subtle focus-visible:outline-none active:scale-[0.97]"
            >
              <Plug size={15} className="flex-shrink-0" />
              <span className={`leading-none ${styles.attachLabelText}`}>{attachLabel ?? "Add resource"}</span>
            </button>
          </div>

          {/* Right actions */}
          <div className="ml-auto flex min-w-0 flex-shrink items-center gap-1.5">
              <DropdownMenu>
                <DropdownMenu.Trigger
                  render={
                    <button
                      type="button"
                      className="group inline-flex h-8 min-w-0 max-w-[180px] cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[13px] leading-5 tracking-[-0.25px] text-kumo-subtle transition-[background-color,color,transform] duration-150 ease-out hover:bg-kumo-tint hover:text-kumo-default focus-visible:bg-kumo-tint focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.97] data-[popup-open]:bg-kumo-tint data-[popup-open]:text-kumo-default"
                      aria-label="Select model"
                    >
                      <span className="min-w-0 truncate">{selectedModelLabel}</span>
                      <CaretDown
                        size={12}
                        weight="bold"
                        className="flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out group-data-[popup-open]:rotate-180"
                      />
                    </button>
                  }
                />
                <DropdownMenu.Content className="!z-[1100] !min-w-[190px] rounded-2xl border border-kumo-line/70 bg-kumo-base p-1 shadow-[0_14px_36px_rgba(82,16,0,0.10)]">
                  {models.map((model) => {
                    const active = selectedModel === model.id;
                    return (
                      <DropdownMenu.Item
                        key={model.id}
                        onClick={() => onModelChange(model.id)}
                        className="!h-auto rounded-xl !px-2 !py-1.5 text-[12px] leading-4 font-normal tracking-[-0.15px] text-kumo-subtle transition-colors data-highlighted:bg-kumo-tint/70 data-highlighted:text-kumo-default"
                      >
                        <span className="min-w-0 flex-1 truncate">{model.name}</span>
                        {active && (
                          <Check size={12} weight="bold" className="ml-3 flex-shrink-0 text-kumo-inactive" />
                        )}
                      </DropdownMenu.Item>
                    );
                  })}
                  <div className="my-1 border-t border-kumo-line/70" />
                  <DropdownMenu.Item
                    onClick={() => onModelChange(null)}
                    className="!h-auto rounded-xl !px-2 !py-1.5 text-[12px] leading-4 font-normal tracking-[-0.15px] text-kumo-subtle transition-colors data-highlighted:bg-kumo-tint/70 data-highlighted:text-kumo-default"
                  >
                    <span className="min-w-0 flex-1 truncate">No agent</span>
                    {selectedModel == null && (
                      <Check size={12} weight="bold" className="ml-3 flex-shrink-0 text-kumo-inactive" />
                    )}
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu>
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

type ChatDisplayEntry =
  | {
      type: "modelChange";
      key: string;
      author: AiChatAuthorInfo;
      sequence: number;
    }
  | {
      type: "message";
      key: string;
      message: AiChatMessage;
      toolCalls?: AiToolCall[];
      toolCallGroups?: ToolCallGroup[];
      lastMessageSequence?: number;
    }
  | {
      type: "workRun";
      key: string;
      toolCalls: AiToolCall[];
      observations: ObservationChatMessage[];
      toolCallGroups: ToolCallGroup[];
      lastMessageSequence: number;
      lastMessageTimestamp: Date;
    }
  | {
      type: "savedChanges";
      key: string;
      message: ChangeChatMessage;
    };

function isObservationActionMessage(msg: AiChatMessage): msg is ObservationChatMessage {
  return msg.type === "action" && msg.actionLog?.type === "observation";
}

type WorkMessageParts = {
  toolCalls: AiToolCall[];
  observations: ObservationChatMessage[];
  lastAgentMessageSequence: number | null;
  lastWorkSequence: number;
  lastWorkTimestamp: Date;
};

function isAssistantMessageWithoutVisibleText(msg: AiChatMessage): msg is Extract<AiChatMessage, { type: "message" }> {
  return (
    msg.type === "message" &&
    msg.author.type !== "user" &&
    !msg.message.trim() &&
    !msg.reasoning?.trim()
  );
}

// Tool-only turns can leave behind empty assistant messages. Don't render them as transcript rows.
function isEmptyAssistantMessage(msg: AiChatMessage): boolean {
  return isAssistantMessageWithoutVisibleText(msg) && (!msg.toolCalls || msg.toolCalls.length === 0);
}

// Assistant messages with tool calls but no text are displayed as work rows.
function getWorkOnlyMessageParts(msg: AiChatMessage): WorkMessageParts | null {
  if (isObservationActionMessage(msg)) {
    return {
      toolCalls: [],
      observations: [msg],
      lastAgentMessageSequence: null,
      lastWorkSequence: msg.sequence,
      lastWorkTimestamp: msg.timestamp,
    };
  }

  if (
    isAssistantMessageWithoutVisibleText(msg) &&
    !!msg.toolCalls &&
    msg.toolCalls.length > 0
  ) {
    return {
      toolCalls: msg.toolCalls,
      observations: [],
      lastAgentMessageSequence: msg.sequence,
      lastWorkSequence: msg.sequence,
      lastWorkTimestamp: msg.timestamp,
    };
  }

  return null;
}

function appendWorkParts(target: WorkMessageParts, source: WorkMessageParts) {
  target.toolCalls.push(...source.toolCalls);
  target.observations.push(...source.observations);
  target.lastWorkSequence = source.lastWorkSequence;
  target.lastWorkTimestamp = source.lastWorkTimestamp;
  if (source.lastAgentMessageSequence !== null) {
    target.lastAgentMessageSequence = source.lastAgentMessageSequence;
  }
}

// Label for the per-turn discard-changes button.
function getDiscardLabel(isTrailing: boolean | undefined): string {
  return isTrailing
    ? "Discard changes from this response"
    : "Discard changes from this response and later responses";
}

function getSavedEditsDiscardLabel(isTrailing: boolean | undefined): string {
  return isTrailing
    ? "Discard saved edits"
    : "Discard saved edits and later changes";
}

// Collapse adjacent work rows; fold trailing work into the preceding assistant
// message so one turn reads as one tool/resource run.
function buildChatDisplayEntries(
  messages: AiChatMessage[],
  changeStatus: ReadonlyMap<number, "pending" | "merged" | "reverted">,
): ChatDisplayEntry[] {
  const result: ChatDisplayEntry[] = [];
  let lastAgentAuthorId: string | null = null;

  const maybePushModelChange = (msg: AiChatMessage) => {
    if (msg.type !== "message" || msg.author.type !== "agent" || isEmptyAssistantMessage(msg)) return;
    if (lastAgentAuthorId === null) {
      lastAgentAuthorId = msg.author.id;
      return;
    }
    if (msg.author.id === lastAgentAuthorId) return;
    lastAgentAuthorId = msg.author.id;
    result.push({
      type: "modelChange",
      key: `model-${msg.chatId}-${msg.sequence}`,
      author: msg.author,
      sequence: msg.sequence,
    });
  };

  const isVisibleSavedChangesMessage = (msg: AiChatMessage): msg is ChangeChatMessage =>
    msg.type === "changes" &&
    msg.author.type === "user" &&
    (changeStatus.get(msg.sequence) ?? "pending") === "pending";

  for (let i = 0; i < messages.length; ) {
    const msg = messages[i];
    maybePushModelChange(msg);

    if (msg.type === "changes") {
      if (isVisibleSavedChangesMessage(msg)) {
        result.push({
          type: "savedChanges",
          key: `saved-changes-${msg.chatId}-${msg.sequence}`,
          message: msg,
        });
      }
      i++;
      continue;
    }

    if (isEmptyAssistantMessage(msg)) {
      i++;
      continue;
    }

    const initialWorkParts = getWorkOnlyMessageParts(msg);
    if (initialWorkParts) {
      const workParts: WorkMessageParts = {
        toolCalls: [...initialWorkParts.toolCalls],
        observations: [...initialWorkParts.observations],
        lastAgentMessageSequence: initialWorkParts.lastAgentMessageSequence,
        lastWorkSequence: initialWorkParts.lastWorkSequence,
        lastWorkTimestamp: initialWorkParts.lastWorkTimestamp,
      };
      let j = i + 1;
      while (j < messages.length) {
        const nextMsg = messages[j];
        if (nextMsg.type === "changes") {
          if (isVisibleSavedChangesMessage(nextMsg)) break;
          j++;
          continue;
        }
        const nextWorkParts = getWorkOnlyMessageParts(nextMsg);
        if (!nextWorkParts) break;
        appendWorkParts(workParts, nextWorkParts);
        j++;
      }

      result.push({
        type: "workRun",
        key: `work-${msg.chatId}-${msg.sequence}`,
        toolCalls: workParts.toolCalls,
        observations: workParts.observations,
        toolCallGroups: buildToolCallGroups(workParts.toolCalls, workParts.observations),
        lastMessageSequence: workParts.lastAgentMessageSequence ?? workParts.lastWorkSequence,
        lastMessageTimestamp: workParts.lastWorkTimestamp,
      });

      i = j;
      continue;
    }

    if (msg.type === "message" && msg.author.type !== "user") {
      const workParts: WorkMessageParts = {
        toolCalls: msg.toolCalls ? [...msg.toolCalls] : [],
        observations: [],
        lastAgentMessageSequence: msg.sequence,
        lastWorkSequence: msg.sequence,
        lastWorkTimestamp: msg.timestamp,
      };
      let j = i + 1;
      while (j < messages.length) {
        const nextMsg = messages[j];
        if (nextMsg.type === "changes") {
          if (isVisibleSavedChangesMessage(nextMsg)) break;
          j++;
          continue;
        }
        const nextWorkParts = getWorkOnlyMessageParts(nextMsg);
        if (!nextWorkParts) break;
        appendWorkParts(workParts, nextWorkParts);
        j++;
      }

      if (workParts.toolCalls.length > 0 || workParts.observations.length > 0) {
        result.push({
          type: "message",
          key: `msg-${msg.chatId}-${msg.sequence}`,
          message: msg,
          toolCalls: workParts.toolCalls,
          toolCallGroups: buildToolCallGroups(workParts.toolCalls, workParts.observations),
          lastMessageSequence: workParts.lastAgentMessageSequence ?? msg.sequence,
        });
        i = j;
        continue;
      }
    }

    result.push({
      type: "message",
      key: `msg-${msg.chatId}-${msg.sequence}`,
      message: msg,
    });
    i++;
  }

  return result;
}

// Transcript spacing helpers.

function isUserMessageEntry(entry: ChatDisplayEntry): boolean {
  return (
    entry.type === "message" &&
    entry.message.type === "message" &&
    entry.message.author.type === "user"
  );
}

function isPureWorkRowEntry(entry: ChatDisplayEntry): boolean {
  if (entry.type === "workRun") return true;
  if (entry.type === "modelChange") return false;
  const m = entry.message;
  return (
    m.type === "action" ||
    m.type === "useGadget" ||
    m.type === "agentCallback" ||
    m.type === "merge" ||
    m.type === "revert"
  );
}

// Assistant messages with grouped work visually end in work rows.
function entryEndsInWorkRow(entry: ChatDisplayEntry): boolean {
  if (isPureWorkRowEntry(entry)) return true;
  if (entry.type !== "message") return false;
  return entry.toolCallGroups !== undefined && entry.toolCallGroups.length > 0;
}

function entryStartsWithWorkRow(entry: ChatDisplayEntry): boolean {
  if (isPureWorkRowEntry(entry)) return true;
  if (entry.type !== "message") return false;
  const m = entry.message;
  return (
    m.type === "message" &&
    m.author.type !== "user" &&
    !m.message &&
    entry.toolCallGroups !== undefined &&
    entry.toolCallGroups.length > 0
  );
}

function rhythmTopClass(
  prev: ChatDisplayEntry | null,
  curr: ChatDisplayEntry,
): string {
  if (!prev) return "";
  if (curr.type === "modelChange") return "mt-4";
  if (prev.type === "modelChange") return "mt-2";
  if (isUserMessageEntry(prev) || isUserMessageEntry(curr)) return "mt-5";
  if (entryEndsInWorkRow(prev) && entryStartsWithWorkRow(curr)) return "mt-2";
  return "mt-4";
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

// Bucket a chat's lastActive into a time grouping for the chat list.
type ChatTimeBucket = "today" | "yesterday" | "thisWeek" | "earlier";

const CHAT_TIME_BUCKET_LABELS: Record<ChatTimeBucket, string> = {
  today: "Today",
  yesterday: "Yesterday",
  thisWeek: "Earlier this week",
  earlier: "Earlier",
};
const CHAT_TIME_BUCKET_ORDER: ChatTimeBucket[] = [
  "today",
  "yesterday",
  "thisWeek",
  "earlier",
];

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function getChatTimeBucket(date: Date, now: Date): ChatTimeBucket {
  const diffDays = Math.round(
    (startOfDay(now).getTime() - startOfDay(date).getTime()) / 86_400_000,
  );
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return "thisWeek";
  return "earlier";
}

// Format a chat's lastActive for display in a row, given its bucket. Buckets
// own the "date" half of the label (via the section header), so rows only show
// what the header doesn't.
function formatChatRowTime(date: Date, bucket: ChatTimeBucket, now: Date): string {
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (bucket === "today" || bucket === "yesterday") {
    return time;
  }
  if (bucket === "thisWeek") {
    const day = date.toLocaleDateString([], { weekday: "short" });
    return `${day} ${time}`;
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(
    [],
    sameYear
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" },
  );
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
  // Human-readable target (e.g. filename) once known from the streaming input.
  target?: string;
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
  // Note: This function only clears chat streaming state, not code streaming state. Chat streaming
  // is reset when a message arrives (once per step), whereas code streaming is reset when code
  // changes arrive (at the end of a turn).
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
  const [chatListScope, setChatListScope] = useState<ChatListScope>("all");
  const [chatListVersion, setChatListVersion] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [updateCounter, setUpdateCounter] = useState(0); // Force re-render when cache updates
  const [proposedChangesVersion, setProposedChangesVersion] = useState(0); // Incremented only for change-affecting messages
  const [draftChangesVersion, setDraftChangesVersion] = useState(0);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState("");
  const [renamingChatId, setRenamingChatId] = useState<number | null>(null);
  const renamingChatIdRef = useRef<number | null>(null);
  const [renamingInput, setRenamingInput] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{
    id: number;
    title: string;
  } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [expandedToolCalls, setExpandedToolCalls] = useState<Set<string>>(
    new Set(),
  );
  const [showThinkingTraces, setShowThinkingTraces] = useState(
    () => getStoredShowThinkingTraces(),
  );
  const [expandedActions, setExpandedActions] = useState<Set<number>>(
    new Set(),
  );
  // Remember auto-expanded actions so user collapses stick.
  const autoExpandedActionIdsRef = useRef<Set<number>>(new Set());
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
  const bumpChatListVersion = () => setChatListVersion((prev) => prev + 1);

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
  const chatList = useMemo(
    () => Array.from(cacheRef.current.chats.values()).sort(
      (a, b) => b.lastActive.getTime() - a.lastActive.getTime(),
    ),
    [chatListVersion],
  );
  const {
    visibleChatList,
    chatListNow,
    bucketedVisibleChats,
    chatListScopes,
  } = useMemo(() => {
    const directCount = chatList.filter((chat) => !chat.spawnerName).length;
    const agentCount = chatList.length - directCount;
    const visible = chatList.filter((chat) => {
      if (chatListScope === "direct") return !chat.spawnerName;
      if (chatListScope === "agents") return Boolean(chat.spawnerName);
      return true;
    });
    const now = new Date();
    const buckets = new Map<ChatTimeBucket, AiChatMetadata[]>();
    for (const chat of visible) {
      const bucket = getChatTimeBucket(chat.lastActive, now);
      let arr = buckets.get(bucket);
      if (!arr) {
        arr = [];
        buckets.set(bucket, arr);
      }
      arr.push(chat);
    }

    return {
      visibleChatList: visible,
      chatListNow: now,
      bucketedVisibleChats: CHAT_TIME_BUCKET_ORDER.flatMap((bucket) => {
        const items = buckets.get(bucket);
        if (!items || items.length === 0) return [];
        return [{ bucket, items }];
      }),
      chatListScopes: [
        { value: "all" as const, count: chatList.length },
        { value: "direct" as const, count: directCount },
        { value: "agents" as const, count: agentCount },
      ],
    };
  }, [chatList, chatListScope]);

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
  const messageStates = useMemo(
    () => computeMessageStates(currentMessages),
    [currentMessages],
  );
  const displayEntries = useMemo(
    () =>
      // Hide agent checkpoints; surface them as turn-level discard actions. User-saved
      // checkpoints get their own compact row so the discard action is attached to the
      // edit that actually created it.
      buildChatDisplayEntries(currentMessages, messageStates.changeStatus),
    [currentMessages, messageStates],
  );

  const entryTopClasses = useMemo(() => {
    const out: string[] = new Array(displayEntries.length);
    for (let i = 0; i < displayEntries.length; i++) {
      out[i] = rhythmTopClass(i > 0 ? displayEntries[i - 1] : null, displayEntries[i]);
    }
    return out;
  }, [displayEntries]);

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
    isAgentActive,
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
      // When the agent stops running (activeAgent becomes unset), do a final full clear of this
      // chat's provisional streaming state. This generally shouldn't be necessary because chat
      // stream state is cleared when the final message arrives and code stream state is cleared
      // when the finalized changes arrive, but doing this final clear will "mop up" if there
      // were any inconsistencies in the streaming.
      const prevChat = cacheRef.current.chats.get(chat.id);
      if (prevChat?.activeAgent && !chat.activeAgent) {
        provisionalRef.current.delete(chat.id);
      }

      cacheRef.current.chats.set(chat.id, chat);
      bumpChatListVersion();
      forceUpdate();
    }

    deleted(chatId: number) {
      // Remove from cache
      cacheRef.current.chats.delete(chatId);
      cacheRef.current.messages.delete(chatId);
      removeChatFromActionMessageIndex(chatId);
      provisionalRef.current.delete(chatId);
      draftRef.current.delete(chatId);
      bumpChatListVersion();

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
        case "toolCallTarget": {
          // Surfaces the file name during streaming for writes and edits so the frontend can update.
          const toolCall = getOrCreateProvisionalToolCall(
            provisional,
            event.toolCallId,
            null,
          );
          toolCall.target = event.target;
          break;
        }
        case "codeReset":
          provisional.codeUpdates = [];
          break;
        case "codeUpdate":
          provisional.codeUpdates.push(event.update);
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
          bumpChatListVersion();
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
    setExpandedActions(new Set());
    setExpandedErrors(new Set());
    autoExpandedActionIdsRef.current = new Set();
    setIsEditingTitle(false);
    setSidebarActiveTab("chat");
  }, [selectedChatId]);

  useEffect(() => {
    let added: number[] | null = null;
    for (const msg of currentMessages) {
      if (
        msg.type === "action" &&
        msg.actionLog?.type === "action" &&
        msg.actionLog.state === "pending" &&
        !autoExpandedActionIdsRef.current.has(msg.actionId)
      ) {
        autoExpandedActionIdsRef.current.add(msg.actionId);
        (added ??= []).push(msg.actionId);
      }
    }
    if (added) {
      setExpandedActions((prev) => {
        const next = new Set(prev);
        for (const id of added!) next.add(id);
        return next;
      });
    }
  }, [currentMessages]);


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

  const cancelListRename = () => {
    renamingChatIdRef.current = null;
    setRenamingChatId(null);
  };

  const startListRename = (chatId: number, title: string) => {
    renamingChatIdRef.current = chatId;
    setRenamingInput(title);
    setRenamingChatId(chatId);
  };

  // Handle saving a renamed chat from the list view
  const handleSaveListRename = async (chatId: number) => {
    if (renamingChatIdRef.current !== chatId) return;

    renamingChatIdRef.current = null;
    setRenamingChatId(null);

    const trimmed = renamingInput.trim();
    const existing = cacheRef.current.chats.get(chatId);
    // Cancel on empty or no-op so commit-on-blur doesn't fire pointless RPCs.
    if (!trimmed || trimmed === existing?.title) return;

    try {
      await overseer.setChatTitle(chatId, trimmed);
      if (existing) {
        cacheRef.current.chats.set(chatId, {
          ...existing,
          title: trimmed,
        });
        bumpChatListVersion();
        forceUpdate();
      }
      toasts.add({ title: "Chat title updated successfully", variant: "success" });
    } catch (err) {
      console.error("Failed to update chat title:", err);
      toasts.add({ title: "Failed to update chat title", variant: "error" });
    }
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
  const handleRevertChanges = useCallback(async (revertFrom: number) => {
    if (selectedChatId === null) return;

    try {
      await overseer.revertChanges(selectedChatId, revertFrom);
      toasts.add({ title: "Draft rewound", variant: "success" });
    } catch (err) {
      console.error("Failed to rewind draft:", err);
      toasts.add({ title: "Failed to rewind draft", variant: "error" });
    }
  }, [overseer, selectedChatId, toasts]);

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

  const toggleToolCallExpansion = useCallback((expansionKey: string) => {
    setExpandedToolCalls((prev) => {
      const next = new Set(prev);
      if (next.has(expansionKey)) {
        next.delete(expansionKey);
      } else {
        next.add(expansionKey);
      }
      return next;
    });
  }, []);

  const toggleShowThinkingTraces = useCallback(() => {
    setShowThinkingTraces((prev) => {
      const next = !prev;
      persistShowThinkingTraces(next);
      return next;
    });
  }, []);

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

  const handleCopyMessage = useCallback(async (message: string) => {
    const ok = await copyToClipboard(message);
    toasts.add({
      title: ok ? "Copied message" : "Unable to copy message",
      variant: ok ? "success" : "error",
    });
  }, [toasts]);

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

  // Track the last visible agent message in each completed turn. This keeps hover actions like
  // copy/timestamp on the final response instead of repeating them for every streamed step.
  const completedAgentTurnMessageSeqs = useMemo(() => {
    const out = new Set<number>();
    let lastAgentMessageSeq: number | null = null;

    for (const m of currentMessages) {
      if (m.type !== "message") continue;
      if (m.author.type === "user") {
        if (lastAgentMessageSeq !== null) out.add(lastAgentMessageSeq);
        lastAgentMessageSeq = null;
      } else if (!isEmptyAssistantMessage(m)) {
        lastAgentMessageSeq = m.sequence;
      }
    }

    if (!isAgentActive && lastAgentMessageSeq !== null) {
      out.add(lastAgentMessageSeq);
    }

    return out;
  }, [currentMessages, isAgentActive]);

  const pendingChangeByTurnItemSeq = useMemo(() => {
    const out = new Map<number, PendingTurnChanges>();
    let lastAgentMessageSeq: number | null = null;
    let lastVisibleWorkSeq: number | null = null;
    let pendingTurnChanges: PendingTurnChanges | null = null;
    let pendingTurnAnchorSeq: number | null = null;

    const currentAnchorSeq = () => lastAgentMessageSeq ?? lastVisibleWorkSeq;

    const attachPendingTurnChanges = () => {
      if (!pendingTurnChanges) return;

      const anchorSeq = currentAnchorSeq();
      if (anchorSeq === null) return;

      if (pendingTurnAnchorSeq !== null && pendingTurnAnchorSeq !== anchorSeq) {
        out.delete(pendingTurnAnchorSeq);
      }

      out.set(anchorSeq, pendingTurnChanges);
      pendingTurnAnchorSeq = anchorSeq;
    };

    const resetTurn = () => {
      lastAgentMessageSeq = null;
      lastVisibleWorkSeq = null;
      pendingTurnChanges = null;
      pendingTurnAnchorSeq = null;
    };

    for (const m of currentMessages) {
      if (m.type === "message") {
        if (m.author.type === "user") {
          resetTurn();
        } else if (!isEmptyAssistantMessage(m)) {
          lastAgentMessageSeq = m.sequence;
          lastVisibleWorkSeq = m.sequence;
          attachPendingTurnChanges();
        }
        continue;
      }

      if (isObservationActionMessage(m) || m.type === "useGadget") {
        lastVisibleWorkSeq = m.sequence;
        attachPendingTurnChanges();
        continue;
      }

      if (m.type === "changes" && m.author.type === "user") {
        resetTurn();
        continue;
      }

      if (
        m.type === "changes" &&
        m.author.type !== "user" &&
        (messageStates.changeStatus.get(m.sequence) ?? "pending") === "pending"
      ) {
        pendingTurnChanges = pendingTurnChanges === null
          ? { revertFrom: m.sequence, through: m.sequence }
          : { revertFrom: pendingTurnChanges.revertFrom, through: m.sequence };
        attachPendingTurnChanges();
      }
    }

    return out;
  }, [currentMessages, messageStates]);

  const renderActionCard = (msg: ActionChatMessage) => {
    const log = msg.actionLog;
    if (!log) return null;

    const isAct = log.type === "action";
    const state = log.state;
    const open = expandedActions.has(msg.actionId);
    const isProc = processingActions.has(msg.actionId);
    const safeResourceUrl = getSafeExternalUrl(log.resourceUrl);

    if (!isAct) {
      const metadata = [
        log.resourceTitle,
        log.bindingName,
      ].filter(Boolean).join(" · ");

      return (
        <div className="group/work max-w-[860px] text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
          <button
            type="button"
            onClick={() => toggleActionExpansion(msg.actionId)}
            className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-1.5 py-1 text-left transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.995]"
            aria-expanded={open}
          >
            <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
              <WorkIcon Icon={MagnifyingGlass} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate">{log.description.title}</span>
                <CaretRight
                  size={13}
                  weight="bold"
                  className={`flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out ${open ? "rotate-90" : ""}`}
                />
              </span>
              {metadata && (
                <span className="mt-1 block truncate text-[12px] leading-4 text-kumo-inactive">
                  {metadata}
                </span>
              )}
            </span>
          </button>
          {open && (
            <div className="ml-8 mt-1 rounded-2xl border border-kumo-line/70 bg-kumo-elevated/45 p-3 text-[13px] leading-[19px] text-kumo-subtle shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]">
              <MarkdownMessage message={log.description.description} />
            </div>
          )}
        </div>
      );
    }

    const isPending = state === "pending";
    const isApproved = state === "approved";
    const isRejected = state === "rejected";
    const showDescription = open;
    const metadata = [log.resourceTitle, log.bindingName]
      .filter(Boolean)
      .join(" · ");
    const titlePrefix = isPending ? "Approve action: " : "";
    const stateLabel = isApproved
      ? "Approved"
      : isRejected
        ? "Rejected"
        : null;
    const stateLabelCls = isRejected
      ? "text-kumo-danger"
      : "text-kumo-inactive";

    return (
      <div className="group/work max-w-[860px] text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
        <div className="flex w-full items-center gap-2 px-1.5 py-1">
          <button
            type="button"
            onClick={() => toggleActionExpansion(msg.actionId)}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md text-left transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.995]"
            aria-expanded={open}
          >
            <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center" aria-hidden="true">
              {isPending ? (
                <span className="h-1.5 w-1.5 rounded-full bg-kumo-brand" />
              ) : (
                <WorkIcon Icon={LinkSimple} />
              )}
            </span>
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="min-w-0 truncate">
                {titlePrefix && (
                  <span className="font-medium text-kumo-default">{titlePrefix}</span>
                )}
                <span className={isPending ? "text-kumo-default" : ""}>
                  {log.description.title}
                </span>
              </span>
              {stateLabel && (
                <span className={`text-[12px] font-medium ${stateLabelCls}`}>
                  {stateLabel}
                </span>
              )}
              <CaretRight
                size={13}
                weight="bold"
                className={`flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out ${open ? "rotate-90" : ""}`}
              />
            </span>
          </button>
          {isPending && (
            <div className="flex flex-shrink-0 items-center gap-2 text-[13px] leading-4">
              <Tooltip content="Reject this action." asChild>
                <button
                  type="button"
                  onClick={() => handleRejectAction(msg.actionId)}
                  disabled={isProc}
                  className="cursor-pointer rounded-md px-1 py-0.5 font-medium text-kumo-inactive transition-colors duration-150 ease-out hover:text-kumo-danger focus-visible:text-kumo-danger focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Reject
                </button>
              </Tooltip>
              <Tooltip content="Approve this action." asChild>
                <button
                  type="button"
                  onClick={() => handleApproveAction(msg.actionId)}
                  disabled={isProc}
                  className="cursor-pointer rounded-md px-1 py-0.5 font-medium text-kumo-default transition-[color,opacity,transform] duration-150 ease-out hover:text-kumo-default-hover focus-visible:text-kumo-default-hover focus-visible:outline-none active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Approve
                </button>
              </Tooltip>
            </div>
          )}
        </div>
        {showDescription && (
          <div className="ml-8 mt-1 space-y-1 text-[13px] leading-[19px] tracking-[-0.25px] text-kumo-subtle">
            <div className={`chat-panel max-h-[200px] overflow-y-auto pr-1 ${styles.markdownContent}`}>
              <MarkdownMessage message={log.description.description} />
            </div>
            {metadata && (
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] leading-4 text-kumo-inactive">
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
                  <span aria-hidden="true">·</span>
                )}
                {log.bindingName && (
                  <span className="font-mono text-[11px]">{log.bindingName}</span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // ─── sidebar list content (reused in both modes) ──────────────────────────
  const chatListPanel = (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Chat list header — title doubles as the scope switcher */}
      <div className="flex h-12 flex-shrink-0 items-center border-b border-kumo-line px-4">
        <DropdownMenu>
          <DropdownMenu.Trigger
            render={
              <button
                type="button"
                className="group flex h-8 -ml-1.5 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-left transition-colors duration-150 ease-out hover:bg-kumo-tint/60 focus-visible:bg-kumo-tint/60 focus-visible:outline-none data-[popup-open]:bg-kumo-tint/60"
                aria-label="Filter conversations"
              >
                <span className="text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                  {CHAT_LIST_SCOPE_LABELS[chatListScope]}
                </span>
                <CaretDown
                  size={10}
                  weight="bold"
                  className="text-kumo-inactive transition-transform duration-150 ease-out group-data-[popup-open]:rotate-180"
                />
              </button>
            }
          />
          <DropdownMenu.Content className="!z-[1100] !min-w-[200px] rounded-lg border border-kumo-line bg-kumo-base p-1 shadow-[0_8px_20px_rgba(82,16,0,0.10)]">
            {chatListScopes.map((scope) => {
              const active = chatListScope === scope.value;
              return (
                <DropdownMenu.Item
                  key={scope.value}
                  onClick={() => setChatListScope(scope.value)}
                  className="!h-auto rounded-md !px-2.5 !py-1.5 text-[12px] leading-4 tracking-[-0.2px] text-kumo-default transition-colors data-highlighted:bg-kumo-tint"
                >
                  <span className="mr-2 inline-flex h-3 w-3 items-center justify-center text-kumo-default">
                    {active ? <Check size={11} weight="bold" /> : null}
                  </span>
                  <span className="flex-1">{CHAT_LIST_SCOPE_LABELS[scope.value]}</span>
                  <span className="ml-3 font-mono text-[11px] text-kumo-inactive">
                    {scope.count}
                  </span>
                </DropdownMenu.Item>
              );
            })}
          </DropdownMenu.Content>
        </DropdownMenu>
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
            {visibleChatList.length === 0 ? (
              // Only reachable when a non-"all" scope filters everything out;
              // the all-empty case is handled by the outer chatList.length check.
              <div className="py-8 text-center">
                <p className="text-[13px] leading-[18px] text-kumo-inactive">
                  No {chatListScope === "agents" ? "agent runs" : "direct conversations"} yet
                </p>
                <button
                  type="button"
                  onClick={() => setChatListScope("all")}
                  className="mt-2 cursor-pointer rounded-md px-2 py-1 text-[12px] leading-4 font-medium text-kumo-subtle transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none"
                >
                  Show all conversations
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {bucketedVisibleChats.map(({ bucket, items }) => (
                  <section key={bucket} className="flex flex-col gap-0.5">
                    <p className="mb-1 px-1 text-[11px] font-medium uppercase tracking-[0.08em] text-kumo-inactive">
                      {CHAT_TIME_BUCKET_LABELS[bucket]}
                    </p>
                    {items.map((chat) => (
              <div key={chat.id} className="relative">
                {(() => {
                  const isRenaming = renamingChatId === chat.id;
                  return (
                  <div
                    onClick={isRenaming ? undefined : () => onNavigateToChat(chat.id)}
                    className={`group flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-[background-color] duration-150 ease-out ${
                      isRenaming
                        ? "cursor-default bg-kumo-base ring-1 ring-kumo-ring/40"
                        : sidebarMode && chat.id === selectedChatId
                          ? "cursor-pointer bg-kumo-recessed"
                          : "cursor-pointer hover:bg-kumo-tint"
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        {isRenaming ? (
                          <input
                            type="text"
                            value={renamingInput}
                            onChange={(e) => setRenamingInput(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                handleSaveListRename(chat.id);
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                cancelListRename();
                              }
                            }}
                            onBlur={() => handleSaveListRename(chat.id)}
                            autoFocus
                            spellCheck={false}
                            autoCapitalize="off"
                            autoCorrect="off"
                            aria-label={`Rename ${chat.title}`}
                            className="min-w-0 flex-1 bg-transparent text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default outline-none placeholder:text-kumo-inactive"
                          />
                        ) : (
                          <span className="truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                            {chat.title}
                          </span>
                        )}
                        {!isRenaming && chat.activeAgent ? (
                          <span className="inline-flex flex-shrink-0 cursor-pointer items-center gap-1 text-[11px] leading-4 font-medium text-kumo-brand">
                            <span className="h-1.5 w-1.5 rounded-full bg-kumo-brand animate-pulse" />
                            Working
                          </span>
                        ) : !isRenaming && chat.hasProposedChanges ? (
                          <Tooltip content="This conversation has pending changes" asChild>
                            <span className="inline-flex flex-shrink-0 cursor-pointer items-center gap-1 text-[11px] leading-4 font-medium text-kumo-warning">
                              <span className="h-1.5 w-1.5 rounded-full bg-kumo-warning" />
                              Pending
                            </span>
                          </Tooltip>
                        ) : null}
                      </div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-kumo-inactive">
                        {chat.spawnerName && (
                          <>
                            <span className="truncate">Agent · {chat.spawnerName}</span>
                            <span className="flex-shrink-0" aria-hidden="true">·</span>
                          </>
                        )}
                        <span className="flex-shrink-0">
                          {formatChatRowTime(chat.lastActive, bucket, chatListNow)}
                        </span>
                        {chat.totalCost != null && (
                          <>
                            <span className="flex-shrink-0" aria-hidden="true">·</span>
                            <span className="flex-shrink-0 font-mono">
                              ${chat.totalCost.toFixed(4)}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    {!isRenaming && (
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
                            onClick={() => startListRename(chat.id, chat.title)}
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
                    )}
                  </div>
                  );
                })()}
              </div>
                    ))}
                  </section>
                ))}
              </div>
            )}
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
          showThinkingTraces={showThinkingTraces}
          onToggleThinkingTraces={toggleShowThinkingTraces}
          minRows={2}
          newChat
        />
        {/* Reserve the same height as the token/cost row to avoid layout shift. */}
        <div aria-hidden className="min-h-[1rem]" />
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
                type="button"
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
                type="button"
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
              {!sidebarMode && (
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
                    className={`flex flex-col px-6 pt-8 ${pendingConsoleLogCount > 0 ? "pb-16" : "pb-8"} ${useConstrainedChatWidth ? "mx-auto w-full max-w-[920px]" : ""}`}
                  >
                    {displayEntries.map((entry, entryIndex) => {
                      const entryTopClass = entryTopClasses[entryIndex] ?? "";
                      if (entry.type === "modelChange") {
                        return (
                          <div key={entry.key} className={`${entryTopClass} max-w-[860px] py-1 text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle`}>
                            <div className="flex items-center gap-3 px-1.5 py-1">
                              <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-inactive" aria-hidden="true">
                                <Swap size={16} />
                              </span>
                              <span className="min-w-0 truncate">
                                Switched to {entry.author.name}
                              </span>
                            </div>
                          </div>
                        );
                      }

                      if (entry.type === "savedChanges") {
                        const isOwnChange = entry.message.author.id === currentUser?.id;
                        const actor = isOwnChange ? "You" : entry.message.author.name;
                        const label = `${actor} saved edits`;
                        const discardLabel = getSavedEditsDiscardLabel(
                          entry.message.sequence === lastDurablePendingChange?.sequence,
                        );
                        return (
                          <div key={entry.key} className={`${entryTopClass} group/savedChanges max-w-[860px] py-1 text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle`}>
                            <div className="flex items-center gap-3 px-1.5 py-1">
                              <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-inactive" aria-hidden="true">
                                <PencilSimple size={15} />
                              </span>
                              <span className="min-w-0 truncate font-medium">
                                {label}
                              </span>
                              <div className="flex flex-shrink-0 items-center gap-1 opacity-0 transition-opacity duration-150 ease-out group-hover/savedChanges:opacity-100 group-focus-within/savedChanges:opacity-100">
                                <Tooltip content={discardLabel} asChild>
                                  <button
                                    type="button"
                                    disabled={isAgentActive}
                                    onClick={() => handleRevertChanges(entry.message.sequence)}
                                    className="flex cursor-pointer items-center rounded-md p-1 text-kumo-inactive transition-[color,opacity,transform] duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
                                    aria-label={discardLabel}
                                  >
                                    <ArrowUUpLeft size={15} />
                                  </button>
                                </Tooltip>
                                <Tooltip content={formatFullTimestamp(entry.message.timestamp)} asChild>
                                  <span className="px-1 font-mono text-[11px] leading-4 text-kumo-inactive">
                                    {entry.message.timestamp.toLocaleTimeString([], {
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    })}
                                  </span>
                                </Tooltip>
                              </div>
                            </div>
                          </div>
                        );
                      }

                      if (entry.type === "workRun") {
                        const pendingChange =
                          pendingChangeByTurnItemSeq.get(entry.lastMessageSequence) ?? null;
                        const showFooterOnGroupIndex = pendingChange
                          ? entry.toolCallGroups.length - 1
                          : -1;
                        return (
                          <div key={entry.key} className={`${entryTopClass} min-w-0 w-full max-w-[860px] space-y-1`}>
                            {entry.toolCallGroups.map((group, groupIndex) => (
                              <ToolGroupRow
                                key={group.key}
                                group={group}
                                open={expandedToolCalls.has(group.key)}
                                expandedKeys={expandedToolCalls}
                                onToggle={toggleToolCallExpansion}
                                footerChangeSequence={
                                  groupIndex === showFooterOnGroupIndex
                                    ? pendingChange?.revertFrom
                                    : undefined
                                }
                                footerTimestamp={
                                  groupIndex === showFooterOnGroupIndex
                                    ? entry.lastMessageTimestamp
                                    : undefined
                                }
                                footerIsTrailing={
                                  pendingChange?.through === lastDurablePendingChange?.sequence
                                }
                                footerDisabled={isAgentActive}
                                onFooterRevert={handleRevertChanges}
                              />
                            ))}
                          </div>
                        );
                      }

                      const msg = entry.message;

                      return (
                        <div key={entry.key} className={entryTopClass}>
                        {/* ── user / AI text message ── */}
                        {msg.type === "message" && (
                          msg.author.type === "user" ? (
                            <div className="group/message relative flex flex-col items-end">
                              <div className={`w-fit max-w-[min(680px,78%)] rounded-[24px] rounded-br-lg border border-transparent bg-kumo-bubble-user px-4 py-2.5 text-[14px] leading-[22px] tracking-[-0.25px] text-kumo-default shadow-[0_1px_1px_rgba(82,16,0,0.03),inset_0_1px_0_rgba(255,255,255,0.55)] ${styles.markdownContent}`}>
                                <MarkdownMessage
                                  message={msg.message}
                                  capsules={msg.capsules}
                                />
                              </div>
                              <div className="mt-0.5 flex items-center justify-end gap-2 pr-1 text-[11px] leading-4 text-kumo-inactive opacity-0 transition-opacity duration-150 ease-out group-hover/message:opacity-100 group-focus-within/message:opacity-100">
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
                            </div>
                          ) : (() => {
                            const messageToolGroups = entry.toolCallGroups;
                            const hasMessageText = msg.message.trim().length > 0;
                            const showReasoning = showThinkingTraces && !!msg.reasoning;
                            const actionMessageSeq = entry.lastMessageSequence ?? msg.sequence;
                            const pendingChange = pendingChangeByTurnItemSeq.get(
                              actionMessageSeq,
                            ) ?? null;
                            const attachActionsToToolGroups =
                              !hasMessageText &&
                              !!pendingChange &&
                              !!messageToolGroups &&
                              messageToolGroups.length > 0;
                            const showActions =
                              completedAgentTurnMessageSeqs.has(actionMessageSeq) &&
                              (hasMessageText || (!!pendingChange && !attachActionsToToolGroups));
                            const showFooterOnGroupIndex = attachActionsToToolGroups && pendingChange && messageToolGroups
                              ? messageToolGroups.length - 1
                              : -1;
                            return (
                          <div className="min-w-0 w-full max-w-[860px] space-y-2">
                            <div className="group/agentMessage relative space-y-1.5">
                              {showReasoning && (
                                <ThinkingTraceRow reasoning={msg.reasoning!} />
                              )}

                              {hasMessageText && (
                                <div className={`text-[14px] leading-[22px] tracking-[-0.25px] text-kumo-default ${styles.markdownContent}`}>
                                  <MarkdownMessage
                                    message={msg.message}
                                    capsules={msg.capsules}
                                  />
                                </div>
                              )}

                              {showActions && (
                                <div className="mt-0.5 -ml-1 flex items-center gap-1 opacity-0 transition-opacity duration-150 ease-out group-hover/agentMessage:opacity-100 group-focus-within/agentMessage:opacity-100">
                                  {hasMessageText && (
                                    <Tooltip content="Copy message" asChild>
                                      <button
                                        type="button"
                                        onClick={() => handleCopyMessage(msg.message)}
                                        className="flex cursor-pointer items-center rounded-md p-1 text-kumo-inactive transition-[color,transform] duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.96]"
                                        aria-label="Copy message"
                                      >
                                        <Copy size={15} />
                                      </button>
                                    </Tooltip>
                                  )}
                                  {pendingChange && (() => {
                                    const label = getDiscardLabel(
                                      pendingChange.through === lastDurablePendingChange?.sequence,
                                    );
                                    return (
                                    <Tooltip content={label} asChild>
                                      <button
                                        type="button"
                                        disabled={isAgentActive}
                                        onClick={() => handleRevertChanges(pendingChange.revertFrom)}
                                        className="flex cursor-pointer items-center rounded-md p-1 text-kumo-inactive transition-[color,opacity,transform] duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
                                        aria-label={label}
                                      >
                                        <ArrowUUpLeft size={15} />
                                      </button>
                                    </Tooltip>
                                    );
                                  })()}
                                  <Tooltip content={formatFullTimestamp(msg.timestamp)} asChild>
                                    <span className="px-1 font-mono text-[11px] leading-4 text-kumo-inactive">
                                      {msg.timestamp.toLocaleTimeString([], {
                                        hour: "2-digit",
                                        minute: "2-digit",
                                      })}
                                    </span>
                                  </Tooltip>
                                </div>
                              )}
                            </div>

                            {messageToolGroups && messageToolGroups.length > 0 && (
                              <div className="space-y-1">
                                {messageToolGroups.map((group, groupIndex) => (
                                  <ToolGroupRow
                                    key={group.key}
                                    group={group}
                                    open={expandedToolCalls.has(group.key)}
                                    expandedKeys={expandedToolCalls}
                                    onToggle={toggleToolCallExpansion}
                                    footerChangeSequence={
                                      groupIndex === showFooterOnGroupIndex
                                        ? pendingChange?.revertFrom
                                        : undefined
                                    }
                                    footerTimestamp={
                                      groupIndex === showFooterOnGroupIndex
                                        ? msg.timestamp
                                        : undefined
                                    }
                                    footerIsTrailing={
                                      pendingChange?.through === lastDurablePendingChange?.sequence
                                    }
                                    footerDisabled={isAgentActive}
                                    onFooterRevert={handleRevertChanges}
                                  />
                                ))}
                              </div>
                            )}
                          </div>
                            );
                          })()
                        )}

                        {(msg.type === "merge" || msg.type === "revert") &&
                          (() => {
                            const isMerge = msg.type === "merge";
                            const ts = isMerge
                              ? messageStates.mergeTimestamps.get(msg.sequence)
                              : messageStates.revertTimestamps.get(
                                  msg.sequence,
                                );
                            return (
                              <div className="max-w-[860px] py-1 text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
                                <Tooltip
                                  content={
                                    isMerge
                                      ? `Accepted draft changes${ts ? ` through ${formatFullTimestamp(ts)}` : ""}.`
                                      : `Returned to the gadget state before the prompt sent ${ts ? `at ${ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "earlier"}.`
                                  }
                                  asChild
                                >
                                  <span className="inline-flex items-center gap-3 px-1.5">
                                    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-inactive" aria-hidden="true">
                                      {isMerge ? <Check size={16} /> : <ArrowUUpLeft size={16} />}
                                    </span>
                                    <span className="font-medium">
                                      {msg.author.name}{" "}
                                      {isMerge
                                        ? "accepted changes"
                                        : "restored an earlier draft"}
                                    </span>
                                  </span>
                                </Tooltip>
                              </div>
                            );
                          })()}

                        {msg.type === "action" && renderActionCard(msg)}

                        {msg.type === "useGadget" && (
                          <div className="max-w-[860px] text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
                            <Tooltip content={`Used the gadget at ${formatFullTimestamp(msg.timestamp)}`} asChild>
                              <span className="inline-flex items-center gap-3 px-1.5 py-1">
                                <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-inactive" aria-hidden="true">
                                  <Plug size={16} />
                                </span>
                                <span>Used the gadget</span>
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
                              <div className="group/work max-w-[860px] text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
                                <div className="flex w-full items-center gap-2 px-1.5 py-1">
                                  <button
                                    type="button"
                                    onClick={() => toggleErrorExpansion(key)}
                                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md text-left transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.995]"
                                    aria-expanded={expanded}
                                  >
                                    <Tooltip content={formatFullTimestamp(msg.timestamp)} asChild>
                                      <span className="flex min-w-0 flex-1 items-center gap-2">
                                        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-danger" aria-hidden="true">
                                          <WarningCircle size={16} weight="fill" />
                                        </span>
                                        <span className="flex min-w-0 flex-1 items-center gap-1">
                                          <span className="min-w-0 truncate">
                                            <span className="font-medium text-kumo-danger">Error: </span>
                                            <span className="text-kumo-subtle">{msg.message}</span>
                                          </span>
                                          <CaretRight
                                            size={13}
                                            weight="bold"
                                            className={`flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out ${expanded ? "rotate-90" : ""}`}
                                          />
                                        </span>
                                      </span>
                                    </Tooltip>
                                  </button>
                                  {isLast && (
                                    <Tooltip content="Retry the last action." asChild>
                                      <button
                                        type="button"
                                        onClick={() => handleRetry()}
                                        disabled={selectedModel === null}
                                        className="flex flex-shrink-0 cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-[13px] leading-4 font-medium text-kumo-default transition-[color,opacity,transform] duration-150 ease-out hover:text-kumo-default-hover focus-visible:text-kumo-default-hover focus-visible:outline-none active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
                                      >
                                        <ArrowsClockwise size={12} weight="bold" />
                                        Retry
                                      </button>
                                    </Tooltip>
                                  )}
                                </div>
                                {expanded && (
                                  <div className="ml-8 mt-1">
                                    <pre className="max-h-48 overflow-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
                                      {msg.message}
                                    </pre>
                                  </div>
                                )}
                              </div>
                            );
                          })()}

                        {msg.type === "agentCallback" && (
                          <div className="max-w-[860px] text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
                            <div className="flex items-center gap-3 px-1.5 py-1">
                              <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-inactive" aria-hidden="true">
                                <Code size={16} />
                              </span>
                              <span className="min-w-0 truncate font-mono text-[13px]">
                                self.{msg.methodName}()
                              </span>
                            </div>
                            {msg.argsSummary && (
                              <div className="ml-8 mt-1">
                                <pre className="max-h-24 overflow-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
                                  {msg.argsSummary}
                                </pre>
                              </div>
                            )}
                          </div>
                        )}
                        </div>
                      );
                    })}

                    {currentDraftState && currentDraftState.entries.length > 0 && (() => {
                      const latestAuthor = currentDraftState.latestAuthor;
                      const isUserAuthored = latestAuthor?.type === "user";
                      const title = isUserAuthored
                        ? "Draft changes pending"
                        : "Draft changes in progress";
                      const description = isUserAuthored
                        ? "Your edits are still a live draft."
                        : `${latestAuthor?.name ?? "The agent"} is editing changes for this gadget.`;
                      const lastDraftEntry =
                        currentDraftState.entries[
                          currentDraftState.entries.length - 1
                        ];
                      const lastEntry = displayEntries[displayEntries.length - 1] ?? null;
                      const draftTopClass = !lastEntry
                        ? ""
                        : isUserMessageEntry(lastEntry)
                          ? "mt-6"
                          : entryEndsInWorkRow(lastEntry)
                            ? "mt-2"
                            : "mt-4";
                      return (
                        <div className={`${draftTopClass} max-w-[860px] py-1 text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle`}>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-1.5">
                            <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-inactive" aria-hidden="true">
                              <Pencil size={16} />
                            </span>
                            <Tooltip
                              content={`${description} Last edited ${formatFullTimestamp(lastDraftEntry.timestamp)}`}
                              asChild
                            >
                              <span className="font-medium text-kumo-subtle">
                                {title}
                              </span>
                            </Tooltip>
                            <div className="flex flex-wrap items-center gap-2 text-[13px] leading-4">
                              <Tooltip content="Throw away these draft edits." asChild>
                                <button
                                  type="button"
                                  disabled={isAgentActive}
                                  onClick={handleDiscardDraftChanges}
                                  className="cursor-pointer rounded-md px-1 py-0.5 font-medium text-kumo-inactive transition-colors duration-150 ease-out hover:text-kumo-danger focus-visible:text-kumo-danger focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                  Discard
                                </button>
                              </Tooltip>
                              <Tooltip content="Save these edits as a draft version. They won't affect the gadget until you accept changes." asChild>
                                <button
                                  type="button"
                                  disabled={isAgentActive}
                                  onClick={handleFinalizeDraftChanges}
                                  className="cursor-pointer rounded-md px-1 py-0.5 font-medium text-kumo-default transition-[color,opacity,transform] duration-150 ease-out hover:text-kumo-default-hover focus-visible:text-kumo-default-hover focus-visible:outline-none active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                  Save draft
                                </button>
                              </Tooltip>
                            </div>
                          </div>
                        </div>
                      );
                    })()}

                    {isAgentActive && activeAgent && (() => {
                      // Placeholder shown only while the agent is active but hasn't produced
                      // visible output yet; once real output appears, that speaks for itself.
                      const hasShownReasoning =
                        showThinkingTraces && !!currentProvisionalState?.reasoning;
                      // Only while awaiting the agent's first output this turn; otherwise it
                      // flashes again in the gap after the last message finalizes but before
                      // isAgentActive clears.
                      const lastMessage =
                        currentMessages.length > 0
                          ? currentMessages[currentMessages.length - 1]
                          : null;
                      const awaitingFirstResponse =
                        !lastMessage ||
                        lastMessage.author.type === "user" ||
                        lastMessage.author.type === "gadget";
                      const showThinking =
                        awaitingFirstResponse &&
                        !currentProvisionalState?.text &&
                        !hasShownReasoning &&
                        provisionalToolCalls.length === 0;

                      // Match the spacing this response gets once finalized (see rhythmTopClass)
                      // so it doesn't shift when streaming completes.
                      const lastEntry =
                        displayEntries.length > 0
                          ? displayEntries[displayEntries.length - 1]
                          : null;
                      const provisionalTopClass = !lastEntry
                        ? ""
                        : lastEntry.type === "modelChange"
                          ? "mt-2"
                          : isUserMessageEntry(lastEntry)
                            ? "mt-5"
                            : "mt-4";

                      return (
                        <div className={`group/agent min-w-0 w-full max-w-[860px] space-y-2 ${provisionalTopClass}`}>
                          {showThinking && (
                            <div className={`inline-flex px-1.5 py-1 text-[14px] leading-5 tracking-[-0.25px] ${styles.thinkingShimmer}`}>
                              Thinking
                            </div>
                          )}

                          {showThinkingTraces && currentProvisionalState?.reasoning && (
                            <ThinkingTraceRow reasoning={currentProvisionalState.reasoning} />
                          )}

                          {currentProvisionalState?.text && (
                            <div className={`text-[14px] leading-[22px] tracking-[-0.25px] text-kumo-default ${styles.markdownContent}`}>
                              <MarkdownMessage message={currentProvisionalState.text} />
                            </div>
                          )}

                          {provisionalToolCalls.length > 0 && (() => {
                            const first = provisionalToolCalls[0];
                            const { label, detailLines } =
                              buildProvisionalToolSummary(provisionalToolCalls);
                            const expansionKey = `group-${first.toolCallId}`;
                            const isExpanded = expandedToolCalls.has(expansionKey);
                            const detailCalls = provisionalToolCalls.filter(
                              (t) => t.code || t.output,
                            );
                            return (
                              <div className="space-y-1">
                                <div className="group/work -ml-0.5">
                                  <button
                                    type="button"
                                    onClick={() => toggleToolCallExpansion(expansionKey)}
                                    className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-1.5 py-1 text-left text-kumo-subtle transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.995]"
                                    aria-expanded={isExpanded}
                                  >
                                    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
                                      <WorkIcon Icon={getToolIcon(first.toolName)} />
                                    </span>
                                    <span className="min-w-0 flex-1">
                                      <span className="flex min-w-0 items-center gap-2 text-[14px] leading-5 tracking-[-0.25px]">
                                        <span className="min-w-0 truncate">{label}</span>
                                        <CaretRight
                                          size={13}
                                          weight="bold"
                                          className={`flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out ${isExpanded ? "rotate-90" : ""}`}
                                        />
                                      </span>
                                      {detailLines.length > 1 && (
                                        <span className="mt-1 block truncate font-mono text-[12px] leading-4 text-kumo-inactive">
                                          {detailLines.join(" · ")}
                                        </span>
                                      )}
                                    </span>
                                  </button>
                                  {isExpanded && detailCalls.length > 0 && (
                                    <div className="ml-8 mt-1 space-y-1">
                                      {detailCalls.map((toolCall) => (
                                        <div
                                          key={`stream-tool-${toolCall.toolCallId}`}
                                          className="space-y-3 rounded-2xl border border-kumo-line/70 bg-kumo-elevated/45 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]"
                                        >
                                          {toolCall.code && (
                                            <>
                                              <span className="font-mono text-[11px] leading-4 text-kumo-inactive uppercase tracking-[0.08em]">Code</span>
                                              <pre className="max-h-56 overflow-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
                                                {toolCall.code}
                                              </pre>
                                            </>
                                          )}
                                          {toolCall.output && (
                                            <>
                                              <span className="font-mono text-[11px] leading-4 text-kumo-inactive uppercase tracking-[0.08em]">Output</span>
                                              <pre className="max-h-56 overflow-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
                                                {toolCall.output}
                                              </pre>
                                            </>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })()}
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>

              {/* ── Bottom: input, update state, and cost ──────────────── */}
              <div className={`flex-shrink-0 bg-kumo-base ${sidebarMode ? "" : "border-t border-kumo-line"}`}>
                <div className={useConstrainedChatWidth ? "mx-auto w-full max-w-[920px]" : ""}>
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
                    showThinkingTraces={showThinkingTraces}
                    onToggleThinkingTraces={toggleShowThinkingTraces}
                    draftUpdateBanner={(() => {
                      if (!currentChatMetadata?.hasProposedChanges) return null;

                      const { activeChanges } = messageStates;
                      if (activeChanges.length === 0) return null;
                      const lastActiveChange = lastDurablePendingChange;
                      if (!lastActiveChange) return null;
                      return (
                        <div className="relative flex items-center gap-3 overflow-hidden rounded-t-[calc(1rem-1px)] border-b border-kumo-line bg-kumo-elevated px-3.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)]">
                          <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-kumo-brand/40 to-transparent" aria-hidden="true" />
                          <span className="min-w-0 flex-1 truncate text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
                            Accept changes to save them to the gadget.
                          </span>
                          <Tooltip content={isAgentActive ? "Wait for the agent to finish before accepting changes." : "Accept the current draft update and save it to your gadget."} asChild>
                            <WorkshopButton
                              disabled={isAgentActive}
                              onClick={() =>
                                handleMergeChanges(lastActiveChange.sequence, {
                                  includeDraft: true,
                                })
                              }
                              tone="primary"
                              className="!h-7 !cursor-pointer gap-1 text-[12px]"
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

                  {/* Token / cost summary. */}
                  <div className="-mt-1 flex min-h-[1.25rem] items-start justify-end gap-4 px-4 pb-1 font-mono text-[11px] leading-4 text-kumo-inactive">
                    {currentChatMetadata?.totalTokens != null && (
                      <span>
                        {currentChatMetadata.totalTokens.toLocaleString()} tokens
                      </span>
                    )}
                    {currentChatMetadata?.totalCost != null && (
                      <span>${currentChatMetadata.totalCost.toFixed(4)}</span>
                    )}
                  </div>
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
