import {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  Fragment,
  type ReactNode,
} from "react";
import {
  DropdownMenu,
  Dialog,
  Button as KumoButton,
  Select,
  Tooltip,
  useKumoToastManager,
} from "@cloudflare/kumo";
import {
  CaretLeft,
  Check,
  X,
  Pencil,
  Trash,
  DotsThreeVertical,
  LinkSimple,
  Paperclip,
} from "@phosphor-icons/react";
import { RpcStub, RpcTarget } from "capnweb";
import ReactMarkdown from "react-markdown";
import * as Y from "yjs";
import styles from "./ChatInterface.module.css";
import {
  Overseer,
  GatekeeperClient,
  AiChatMetadata,
  AiChatMessage,
  AiChatSubscriber,
  AiChatAuthorInfo,
  CapsuleSpecifier,
  AiChatStreamEvent,
  AiToolCall,
} from "@gadgets/workshop-shared/api";
import { ResourceDescription } from "@gadgets/workshop-shared/gatekeeper";
import CapsuleOverlay from "./CapsuleOverlay";
import type { SelectableItem } from "./ResourcePicker";
import NewGatekeeperModal from "./NewGatekeeperModal";
import { handlePickerKeyDown } from "./pickerNavigation";

export interface StreamingProposedChanges {
  updates: Uint8Array[];
  count: number;
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
      const gk = await createCapsuleGatekeeper(accountId, activeUrl.text);
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

  // Called by the NewGatekeeperModal when a gatekeeper is created via the attach flow.
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

  // Console log severity colours (banner above the input)
  const logBannerClass =
    consoleLogSeverity === "error"
      ? "border-kumo-danger/40 bg-kumo-danger-tint text-kumo-danger"
      : consoleLogSeverity === "warn"
        ? "border-kumo-warning/40 bg-kumo-warning-tint text-kumo-warning"
        : "border-kumo-line bg-kumo-elevated text-kumo-subtle";

  return (
    <div className="px-3 py-3 relative">
      {/* Console log banner */}
      {pendingConsoleLogCount > 0 && (
        <div
          className={`flex items-center gap-2 mb-2 px-3 py-1.5 rounded-lg border text-xs ${logBannerClass}`}
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
              className="flex-1 text-left truncate font-medium hover:underline"
            >
              Attach {pendingConsoleLogCount} captured log
              {pendingConsoleLogCount !== 1 ? "s" : ""}
            </button>
          </Tooltip>
          <button
            onClick={onDiscardConsoleLogs}
            className="flex-shrink-0 opacity-60 hover:opacity-100 transition-opacity"
          >
            <X size={10} />
          </button>
        </div>
      )}

      {/* Prompt card */}
      <div className="prompt-input rounded-2xl border relative">
        {/* Textarea */}
        <div className="px-4 pt-3 pb-2">
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
                below={newChat}
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
                    ? "Describe what you want to build…"
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
              className="w-full bg-transparent relative z-[1] border-none outline-none p-0 resize-none text-sm leading-relaxed text-kumo-default placeholder:text-kumo-inactive"
            />
          </div>
        </div>

        {/* Footer row: model picker left, attach + send right */}
        <div className="px-3 pb-3 flex items-center justify-between gap-2">
          {/* Model picker */}
          <div className="flex items-center gap-1.5 min-w-0 max-w-[180px]">
            <Select
              aria-label="Select model"
              className="w-full text-sm"
              value={selectedModel ?? models[0]?.id ?? ""}
              onValueChange={(v) => onModelChange(v as string)}
              renderValue={(v) => {
                return models.find(m => m.id === v)?.name ?? String(v)
              }}
            >
              {models.map((m) => (
                <Select.Option key={m.id} value={m.id}>
                  {m.name}
                </Select.Option>
              ))}
            </Select>
          </div>

          {/* Right actions */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {attachLabel ? (
              <button
                onClick={handleAttachOpen}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-kumo-default border border-kumo-line hover:bg-kumo-tint rounded-lg transition-colors"
              >
                <LinkSimple size={16} />
                {attachLabel}
              </button>
            ) : (
              <Tooltip content="Attach resource" asChild>
                <button
                  onClick={handleAttachOpen}
                  className="p-1.5 text-kumo-inactive hover:text-kumo-subtle hover:bg-kumo-tint rounded-lg transition-colors"
                >
                  <Paperclip size={15} />
                </button>
              </Tooltip>
            )}
            <button
              onClick={handleSend}
              disabled={!inputValue.trim() || isAgentActive}
              className={`p-1.5 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed text-kumo-inverse ${
                inputValue.trim() && !isAgentActive
                  ? "bg-kumo-brand hover:bg-kumo-brand-hover"
                  : "bg-kumo-contrast"
              }`}
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
            </button>
          </div>
        </div>
      </div>

      <NewGatekeeperModal
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

interface ChatInterfaceProps {
  overseer: RpcStub<Overseer>;
  selectedChatId: number | null;
  onNavigateToChat: (
    chatId: number | null,
    options?: { replace?: boolean },
  ) => void;
  onProposedChangesChange?: (proposedChanges: Uint8Array | undefined) => void;
  onStreamingProposedChangesChange?: (
    updates: StreamingProposedChanges | undefined,
  ) => void;
  onFileEdited?: (filename: string) => void;
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
  constrainChatWidth?: boolean;
}

// Client-side cache for chats and messages (survives reconnects)
interface ChatCache {
  chats: Map<number, AiChatMetadata>;
  messages: Map<number, AiChatMessage[]>;
  lastMessageTimestamp: Date | null;
}

type ProvisionalToolCallState = {
  toolCallId: string;
  toolName: AiToolCall["toolName"] | null;
  code: string;
  output: string;
  error?: string;
  finished: boolean;
};

type ProvisionalChatState = {
  text: string;
  reasoning: string;
  toolCalls: ProvisionalToolCallState[];
  toolCallsById: Map<string, ProvisionalToolCallState>;
  codeUpdates: Uint8Array[];
};

function createProvisionalChatState(): ProvisionalChatState {
  return {
    text: "",
    reasoning: "",
    toolCalls: [],
    toolCallsById: new Map(),
    codeUpdates: [],
  };
}

function clearProvisionalTextState(state: ProvisionalChatState) {
  state.text = "";
  state.reasoning = "";
  state.toolCalls = [];
  state.toolCallsById.clear();
}

function clearProvisionalCodeState(state: ProvisionalChatState) {
  state.codeUpdates = [];
}

function isProvisionalChatStateEmpty(state: ProvisionalChatState) {
  return (
    state.text === "" &&
    state.reasoning === "" &&
    state.toolCalls.length === 0 &&
    state.codeUpdates.length === 0
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

// Render a text segment as inline markdown, preserving leading/trailing whitespace
// that CommonMark paragraph parsing would otherwise strip.
function renderInlineMarkdown(text: string, key: string): ReactNode {
  const leading = text.length - text.trimStart().length;
  const trailing = text.length - text.trimEnd().length;
  if (leading >= text.length) {
    // All whitespace — render directly.
    return <Fragment key={key}>{text}</Fragment>;
  }
  return (
    <Fragment key={key}>
      {leading > 0 && text.slice(0, leading)}
      <ReactMarkdown
        skipHtml={true}
        components={{ p: ({ children }) => <>{children}</> }}
      >
        {text.slice(leading, trailing > 0 ? text.length - trailing : undefined)}
      </ReactMarkdown>
      {trailing > 0 && text.slice(text.length - trailing)}
    </Fragment>
  );
}

// Render a message that may contain capsule placeholders. Splits the message at
// capsule positions and interleaves ReactMarkdown text segments with capsule pills.
function renderMessageWithCapsules(
  message: string,
  capsules: CapsuleSpecifier[],
) {
  const sorted = [...capsules].sort((a, b) => a.position - b.position);
  const segments: React.ReactNode[] = [];
  let pos = 0;

  for (let i = 0; i < sorted.length; i++) {
    const capsule = sorted[i];

    // Text before this capsule.
    if (capsule.position > pos) {
      segments.push(
        renderInlineMarkdown(message.slice(pos, capsule.position), `t${i}`),
      );
    }

    // Capsule pill.
    segments.push(
      <Tooltip
        key={`c${i}`}
        content={
          <a
            href={capsule.description.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "inherit" }}
          >
            {capsule.description.url}
          </a>
        }
      >
        <span className={styles.capsulePill}>{capsule.description.title}</span>
      </Tooltip>,
    );

    pos = capsule.position + capsule.length;
  }

  // Remaining text after last capsule.
  if (pos < message.length) {
    segments.push(renderInlineMarkdown(message.slice(pos), "tail"));
  }

  return <>{segments}</>;
}

function ChatInterface({
  overseer,
  selectedChatId,
  onNavigateToChat,
  onProposedChangesChange,
  onStreamingProposedChangesChange,
  onFileEdited,
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
  constrainChatWidth,
}: ChatInterfaceProps) {
  // Persistent cache that survives reconnects
  const toasts = useKumoToastManager();

  const cacheRef = useRef<ChatCache>({
    chats: new Map(),
    messages: new Map(),
    lastMessageTimestamp: null,
  });
  const provisionalRef = useRef<Map<number, ProvisionalChatState>>(new Map());

  // UI state
  const [_isSubscribed, setIsSubscribed] = useState(false);
  const [chatListReady, setChatListReady] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [updateCounter, setUpdateCounter] = useState(0); // Force re-render when cache updates
  const [proposedChangesVersion, setProposedChangesVersion] = useState(0); // Incremented only for change-affecting messages
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
  const [expandedReasoning, setExpandedReasoning] = useState<Set<string>>(
    new Set(),
  );
  const [expandedActions, setExpandedActions] = useState<Set<number>>(
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

  // Sidebar resize handling
  useEffect(() => {
    if (!isSidebarResizing) return;
    const onMove = (e: MouseEvent) => {
      const newWidth = Math.max(200, Math.min(500, e.clientX));
      onSidebarResize?.(newWidth);
    };
    const onUp = () => setIsSidebarResizing(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isSidebarResizing, onSidebarResize]);

  // Track which tool calls we've already processed for file selection
  const processedToolCallsRef = useRef<Set<string>>(new Set());

  // Refs for accessing current values in subscriber callbacks
  const selectedChatIdRef = useRef<number | null>(null);
  const onNavigateToChatRef = useRef(onNavigateToChat);
  onNavigateToChatRef.current = onNavigateToChat;

  // Subscription stub (wrapped in object for useState)
  const subscriptionRef = useRef<RpcStub<{}> | null>(null);

  // Ref for auto-scrolling messages
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isScrolledToBottomRef = useRef(true);

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

  // Get metadata for selected chat
  const currentChatMetadata =
    selectedChatId !== null ? cacheRef.current.chats.get(selectedChatId) : null;

  const currentProvisionalState =
    selectedChatId !== null
      ? (provisionalRef.current.get(selectedChatId) ?? null)
      : null;

  const visibleProvisionalToolCalls =
    currentProvisionalState?.toolCalls.filter((toolCall) => {
      return toolCall.toolName === "executeCode";
    }) ?? [];

  const useConstrainedChatWidth = sidebarMode || constrainChatWidth;

  const currentStreamingChanges = currentProvisionalState?.codeUpdates;
  const currentStreamingChangesCount = currentStreamingChanges?.length ?? 0;
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
      visibleProvisionalToolCalls.length > 0);

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

  // Auto-merge proposed changes when the agent finishes on a single-thread gadget.
  // Track whether user is scrolled to the bottom of the messages area
  const handleMessagesScroll = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    // Consider "at bottom" if within 30px of the end
    isScrolledToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  }, []);

  // Auto-scroll to bottom when messages change, but only if already at bottom
  useEffect(() => {
    if (isScrolledToBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [
    currentMessages,
    hasVisibleProvisionalContent,
    currentStreamingChangesCount,
  ]);

  // Always scroll to bottom when switching chats
  useEffect(() => {
    isScrolledToBottomRef.current = true;
    messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
  }, [selectedChatId]);

  // Initialize title input when selecting a chat
  useEffect(() => {
    if (currentChatMetadata) {
      setTitleInput(currentChatMetadata.title);
    }
  }, [currentChatMetadata?.title]);

  // Update selected model when switching chats
  useEffect(() => {
    if (selectedChatId === null) {
      // For new chats, use localStorage or first model
      const lastSelectedModel = localStorage.getItem("lastSelectedModel");
      if (
        lastSelectedModel &&
        availableModels.some((m) => m.id === lastSelectedModel)
      ) {
        setSelectedModel(lastSelectedModel);
      } else if (availableModels.length > 0) {
        setSelectedModel(availableModels[0].id);
      }
    } else {
      // For existing threads:
      // 1. If an AI agent is currently active, use that agent's model
      if (activeAgent) {
        setSelectedModel(activeAgent.id);
      } else {
        // 2. Otherwise, check the last message in the thread
        const messageMessages = currentMessages.filter(
          (msg) => msg.type === "message",
        );
        if (messageMessages.length > 0) {
          const lastMessage = messageMessages[messageMessages.length - 1];
          if (lastMessage.author.type === "agent") {
            // Last message was from AI, use that model
            setSelectedModel(lastMessage.author.id);
          } else {
            // Last message was from human with no AI responding, so it must have been sent with null model
            setSelectedModel(null);
          }
        } else {
          // No messages yet, set to null
          setSelectedModel(null);
        }
      }
    }
  }, [selectedChatId, availableModels, currentMessages, activeAgent]);

  // Keep the ref in sync with selectedChatId state
  useEffect(() => {
    selectedChatIdRef.current = selectedChatId;
  }, [selectedChatId]);

  // Detect when files are edited via tool calls and notify parent
  useEffect(() => {
    if (!onFileEdited || selectedChatId === null) return;

    // Look through all messages for editFile tool calls
    currentMessages.forEach((msg) => {
      if (msg.type === "message" && msg.toolCalls) {
        msg.toolCalls.forEach((toolCall) => {
          // If we haven't processed this tool call yet and it's an editFile
          if (
            !processedToolCallsRef.current.has(toolCall.toolCallId) &&
            toolCall.toolName === "editFile"
          ) {
            // Mark as processed
            processedToolCallsRef.current.add(toolCall.toolCallId);
            // Notify parent
            onFileEdited(toolCall.input.filename);
          }
        });
      }
    });
  }, [currentMessages, selectedChatId, onFileEdited]);

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
      provisionalRef.current.delete(chatId);

      // If currently viewing this chat, go back to list
      // Use replace to prevent browser-back returning to the deleted chat
      if (selectedChatIdRef.current === chatId) {
        onNavigateToChatRef.current(null, { replace: true });
      }

      forceUpdate();
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
          toolCall.error = event.error;
          break;
        }
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

          // Set default model: first try localStorage, then fall back to first model
          const lastSelectedModel = localStorage.getItem("lastSelectedModel");
          if (
            lastSelectedModel &&
            models.some((m) => m.id === lastSelectedModel)
          ) {
            setSelectedModel(lastSelectedModel);
          } else if (models.length > 0) {
            setSelectedModel(models[0].id);
          }

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

  // Reset per-chat UI state when selectedChatId changes
  useEffect(() => {
    setExpandedToolCalls(new Set());
    setExpandedReasoning(new Set());
    setExpandedActions(new Set());
    setExpandedErrors(new Set());
    processedToolCallsRef.current = new Set();
    setIsEditingTitle(false);
    setSidebarActiveTab("chat");
  }, [selectedChatId]);

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
    if (modelId !== null) {
      localStorage.setItem("lastSelectedModel", modelId);
    }
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
  const handleMergeChanges = async (mergeThrough: number) => {
    if (selectedChatId === null) return;

    try {
      await overseer.mergeChanges(selectedChatId, mergeThrough);
      toasts.add({ title: "Changes merged successfully", variant: "success" });
    } catch (err) {
      console.error("Failed to merge changes:", err);
      toasts.add({ title: "Failed to merge changes", variant: "error" });
    }
  };

  // Handle reverting changes from a specific sequence number onward
  const handleRevertChanges = async (revertFrom: number) => {
    if (selectedChatId === null) return;

    try {
      await overseer.revertChanges(selectedChatId, revertFrom);
      toasts.add({ title: "Changes reverted successfully", variant: "success" });
    } catch (err) {
      console.error("Failed to revert changes:", err);
      toasts.add({ title: "Failed to revert changes", variant: "error" });
    }
  };

  // Handle approving an action from the chat thread
  const handleApproveAction = async (actionId: number) => {
    setProcessingActions((prev) => new Set(prev).add(actionId));
    try {
      await overseer.approveAction(actionId);
      // Optimistically update the local message cache
      if (selectedChatId !== null) {
        const messages = cacheRef.current.messages.get(selectedChatId);
        if (messages) {
          for (const msg of messages) {
            if (
              msg?.type === "action" &&
              msg.actionId === actionId &&
              msg.actionLog
            ) {
              msg.actionLog.state = "approved";
              if (msg.actionLog.type === "action") {
                msg.actionLog.appliedAt = new Date();
              }
              break;
            }
          }
        }
      }
      forceUpdate();
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
      // Optimistically update the local message cache
      if (selectedChatId !== null) {
        const messages = cacheRef.current.messages.get(selectedChatId);
        if (messages) {
          for (const msg of messages) {
            if (
              msg?.type === "action" &&
              msg.actionId === actionId &&
              msg.actionLog
            ) {
              msg.actionLog.state = "rejected";
              break;
            }
          }
        }
      }
      forceUpdate();
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

  // Toggle reasoning expansion
  const toggleReasoningExpansion = (messageKey: string) => {
    setExpandedReasoning((prev) => {
      const next = new Set(prev);
      if (next.has(messageKey)) {
        next.delete(messageKey);
      } else {
        next.add(messageKey);
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
    if (selectedChatId === null || selectedModel === null) return;

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

  // ─── avatars ────────────────────────────────────────────────────────────────
  const AssistantAvatar = () => (
    <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 bg-kumo-brand">
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
  const UserAvatar = ({ name }: { name: string }) => (
    <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 bg-kumo-tint">
      <span className="text-[10px] font-semibold text-kumo-strong">
        {name[0]?.toUpperCase()}
      </span>
    </div>
  );

  // ─── sidebar list content (reused in both modes) ──────────────────────────
  const chatListPanel = (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Chat list header */}
      <div className="flex items-center px-4 h-12 border-b border-kumo-line flex-shrink-0">
        <span className="text-sm font-medium text-kumo-default">
          Conversations
        </span>
      </div>
      {/* Chat list */}
      <div className="flex-1 overflow-y-auto chat-panel p-4">
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
            <p className="text-xs font-medium text-kumo-subtle mb-2">Recent</p>
            {chatList.map((chat) => (
              <div key={chat.id} className="relative">
                {renamingChatId === chat.id ? (
                  /* ── Inline rename mode ─────────────────────────────── */
                  <div
                    className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-xl border ${
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
                      className="flex-1 min-w-0 text-sm font-medium bg-kumo-tint border border-kumo-brand rounded-md px-2 py-0.5 focus:outline-none text-kumo-default"
                    />
                    <button
                      onClick={() => handleSaveListRename(chat.id)}
                      disabled={!renamingInput.trim()}
                      className="p-1 rounded text-kumo-subtle hover:text-kumo-brand transition-colors disabled:opacity-30"
                    >
                      <Check size={13} />
                    </button>
                    <button
                      onClick={() => setRenamingChatId(null)}
                      className="p-1 rounded text-kumo-subtle hover:text-kumo-default transition-colors"
                    >
                      <X size={13} />
                    </button>
                  </div>
                ) : (
                  /* ── Normal chat list item ─────────────────────────── */
                  <div
                    className={`w-full text-left flex items-start gap-3 px-3 py-2.5 rounded-xl border transition-colors group cursor-pointer ${
                      sidebarMode && chat.id === selectedChatId
                        ? "border-kumo-brand/30 bg-kumo-tint"
                        : chat.spawnerName
                          ? "border-[var(--color-compute-100)]/30 bg-[var(--color-compute-200)] hover:border-[var(--color-compute-100)]/50"
                          : "border-transparent hover:border-kumo-line hover:bg-kumo-elevated"
                    }`}
                  >
                    {chat.spawnerName && (
                      <div className="w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0 mt-0.5 bg-kumo-tint">
                        <span className="text-[9px] font-bold text-[var(--color-compute-100)]">
                          A
                        </span>
                      </div>
                    )}
                    {/* Clickable area for navigation */}
                    <div
                      className="flex-1 min-w-0"
                      onClick={() => onNavigateToChat(chat.id)}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-kumo-default truncate">
                          {chat.title}
                        </span>
                        {chat.activeAgent && (
                          <span className="w-1.5 h-1.5 rounded-full bg-kumo-brand animate-pulse flex-shrink-0" />
                        )}
                        {chat.spawnerName && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-compute-200)] text-[var(--color-compute-100)] border border-[var(--color-compute-100)]/20 flex-shrink-0">
                            {chat.spawnerName}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-kumo-inactive truncate">
                          {chat.lastActive.toLocaleDateString()}{" "}
                          {chat.lastActive.toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                        {chat.totalCost != null && (
                          <span className="text-xs font-mono text-kumo-inactive flex-shrink-0">
                            ${chat.totalCost.toFixed(4)}
                          </span>
                        )}
                      </div>
                    </div>
                    {/* ··· menu */}
                    <DropdownMenu>
                      <DropdownMenu.Trigger
                        render={
                          <button
                            className="p-1 rounded-md text-kumo-inactive opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-kumo-default hover:bg-kumo-tint transition-all flex-shrink-0 mt-0.5"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <DotsThreeVertical size={14} />
                          </button>
                        }
                      />
                      <DropdownMenu.Content>
                        <DropdownMenu.Item
                          onClick={() => {
                            setRenamingInput(chat.title);
                            setRenamingChatId(chat.id);
                          }}
                        >
                          Rename
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator />
                        <DropdownMenu.Item
                          variant="danger"
                          onClick={() => handleDeleteChat(chat.id, chat.title)}
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

      {/* New chat input — pinned to bottom */}
      <div className="flex-shrink-0 p-4 border-t border-kumo-line">
        <p className="text-xs font-medium text-kumo-subtle mb-3">
          New conversation
        </p>
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
            className="w-1 flex-shrink-0 bg-kumo-line hover:bg-kumo-brand cursor-col-resize transition-colors relative"
            onMouseDown={() => setIsSidebarResizing(true)}
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
            <div className="flex items-center px-4 border-b border-kumo-line flex-shrink-0 gap-1 h-12">
              <button
                onClick={() => setSidebarActiveTab("chat")}
                className={`px-3 py-1.5 text-sm rounded-md transition-colors font-medium ${
                  sidebarActiveTab === "chat"
                    ? "bg-kumo-tint text-kumo-default"
                    : "text-kumo-subtle hover:text-kumo-default hover:bg-kumo-elevated"
                }`}
              >
                Chat
              </button>
              <button
                onClick={() => setSidebarActiveTab("connections")}
                className={`px-3 py-1.5 text-sm rounded-md transition-colors font-medium ${
                  sidebarActiveTab === "connections"
                    ? "bg-kumo-tint text-kumo-default"
                    : "text-kumo-subtle hover:text-kumo-default hover:bg-kumo-elevated"
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
                <div className="flex items-center justify-between px-4 h-12 border-b border-kumo-line flex-shrink-0 gap-2">
                  <button
                    onClick={() => onNavigateToChat(null)}
                    className="p-1 text-kumo-subtle hover:text-kumo-default rounded-md hover:bg-kumo-tint transition-colors flex-shrink-0"
                    title="Back to conversations"
                  >
                    <CaretLeft size={14} />
                  </button>

                  {isEditingTitle ? (
                    <div className="flex items-center gap-1 flex-1 min-w-0">
                      <input
                        type="text"
                        value={titleInput}
                        onChange={(e) => setTitleInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleSaveChatTitle();
                          if (e.key === "Escape") handleCancelTitleEdit();
                        }}
                        autoFocus
                        className="flex-1 min-w-0 text-sm font-medium bg-kumo-tint border border-kumo-brand rounded-md px-2 py-0.5 focus:outline-none text-kumo-default"
                      />
                      <button
                        onClick={handleSaveChatTitle}
                        disabled={!titleInput.trim()}
                        className="p-1 rounded text-kumo-subtle hover:text-kumo-brand transition-colors disabled:opacity-30"
                      >
                        <Check size={13} />
                      </button>
                      <button
                        onClick={handleCancelTitleEdit}
                        className="p-1 rounded text-kumo-subtle hover:text-kumo-default transition-colors"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ) : (
                    <>
                      <span className="flex-1 min-w-0 text-sm font-medium text-kumo-default truncate">
                        {currentChatMetadata?.title || "Chat"}
                      </span>
                      <button
                        onClick={() => setIsEditingTitle(true)}
                        className="p-1 text-kumo-inactive hover:text-kumo-subtle rounded-md hover:bg-kumo-tint transition-colors flex-shrink-0"
                        title="Rename chat"
                      >
                        <Pencil size={11} />
                      </button>
                    </>
                  )}

                  <button
                    onClick={() => handleDeleteChat()}
                    className="p-1 text-kumo-inactive hover:text-kumo-danger rounded-md hover:bg-kumo-danger-tint transition-colors flex-shrink-0"
                    title="Delete chat"
                  >
                    <Trash size={14} />
                  </button>
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
                    className={`px-4 py-4 space-y-5 ${useConstrainedChatWidth ? "max-w-3xl mx-auto w-full" : ""}`}
                  >
                    {currentMessages.map((msg, idx) => (
                      <div key={`${msg.chatId}-${msg.sequence}`}>
                        {/* ── user / AI text message ── */}
                        {msg.type === "message" && (
                          <div className="flex gap-3 items-start">
                            {msg.author.type === "user" ? (
                              <UserAvatar name={msg.author.name} />
                            ) : (
                              <AssistantAvatar />
                            )}
                            <div className="flex-1 min-w-0 space-y-1.5">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-semibold text-kumo-default">
                                  {msg.author.name}
                                </span>
                                <span className="font-mono text-[11px] text-kumo-inactive">
                                  {msg.timestamp.toLocaleTimeString([], {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })}
                                </span>
                              </div>

                              {/* Reasoning */}
                              {msg.reasoning &&
                                (() => {
                                  const key = `${msg.chatId}-${msg.sequence}`;
                                  const open = expandedReasoning.has(key);
                                  return (
                                    <div className="mb-1.5">
                                      <button
                                        onClick={() =>
                                          toggleReasoningExpansion(key)
                                        }
                                        className="flex items-center gap-1.5 text-[11px] text-kumo-inactive hover:text-kumo-subtle transition-colors"
                                      >
                                        <svg
                                          width="8"
                                          height="8"
                                          viewBox="0 0 24 24"
                                          fill="none"
                                          stroke="currentColor"
                                          strokeWidth="2.5"
                                          className={`transition-transform ${open ? "rotate-90" : ""}`}
                                        >
                                          <polyline points="9 18 15 12 9 6" />
                                        </svg>
                                        <span className="italic">
                                          Reasoning
                                        </span>
                                      </button>
                                      {open && (
                                        <div className="mt-1 text-xs text-kumo-subtle whitespace-pre-wrap leading-relaxed pl-3 border-l-2 border-kumo-fill">
                                          {msg.reasoning}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })()}

                              {/* Message content */}
                              <div
                                className={`text-sm leading-relaxed text-kumo-default ${styles.markdownContent}`}
                              >
                                {msg.capsules && msg.capsules.length > 0 ? (
                                  renderMessageWithCapsules(
                                    msg.message,
                                    msg.capsules,
                                  )
                                ) : (
                                  <ReactMarkdown skipHtml={true}>
                                    {msg.message}
                                  </ReactMarkdown>
                                )}
                              </div>

                              {/* Tool calls */}
                              {msg.toolCalls && msg.toolCalls.length > 0 && (
                                <div className="space-y-1 mt-2">
                                  {msg.toolCalls.map((tc, tcIdx) => {
                                    const open = expandedToolCalls.has(
                                      tc.toolCallId,
                                    );
                                    const label =
                                      (tc.toolName === "readFile" ||
                                        tc.toolName === "editFile") &&
                                      tc.input?.filename
                                        ? `${tc.toolName}  ${tc.input.filename}`
                                        : tc.toolName;
                                    return (
                                      <div
                                        key={`${msg.chatId}-${msg.sequence}-tc-${tcIdx}`}
                                        className={`rounded-lg border overflow-hidden ${tc.error ? "border-kumo-danger/30 bg-kumo-danger-tint" : "border-kumo-line bg-kumo-elevated"}`}
                                      >
                                        <button
                                          onClick={() =>
                                            toggleToolCallExpansion(
                                              tc.toolCallId,
                                            )
                                          }
                                          className="w-full flex items-center gap-2 px-3 py-2 text-left"
                                        >
                                          <svg
                                            width="8"
                                            height="8"
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="2.5"
                                            className={`flex-shrink-0 transition-transform ${open ? "rotate-90" : ""} text-kumo-subtle`}
                                          >
                                            <polyline points="9 18 15 12 9 6" />
                                          </svg>
                                          <span className="flex-1 text-xs font-mono text-kumo-default truncate">
                                            {label}
                                          </span>
                                          {tc.error && (
                                            <span className="text-[10px] font-bold text-kumo-danger flex-shrink-0">
                                              ERROR
                                            </span>
                                          )}
                                        </button>
                                        {open && (
                                          <div className="px-3 pb-3 pt-1 border-t border-kumo-line space-y-2">
                                            {tc.error && (
                                              <pre className="text-xs text-kumo-danger font-mono whitespace-pre-wrap bg-kumo-base rounded p-2">
                                                {tc.error}
                                              </pre>
                                            )}
                                            {tc.toolName === "executeCode" ? (
                                              <>
                                                <span className="font-mono text-[10px] text-kumo-subtle uppercase tracking-wider">
                                                  Code
                                                </span>
                                                <pre className="text-xs font-mono text-kumo-subtle whitespace-pre-wrap bg-kumo-base rounded p-2 max-h-48 overflow-auto">
                                                  {tc.input.code}
                                                </pre>
                                                {tc.output && (
                                                  <>
                                                    <span className="font-mono text-[10px] text-kumo-subtle uppercase tracking-wider">
                                                      Output
                                                    </span>
                                                    <pre className="text-xs font-mono text-kumo-subtle whitespace-pre-wrap bg-kumo-base rounded p-2 max-h-48 overflow-auto">
                                                      {tc.output}
                                                    </pre>
                                                  </>
                                                )}
                                              </>
                                            ) : (
                                              <pre className="text-xs font-mono text-kumo-subtle whitespace-pre-wrap bg-kumo-base rounded p-2 max-h-48 overflow-auto">
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
                        )}

                        {/* ── changes message ── */}
                        {msg.type === "changes" &&
                          (() => {
                            const status =
                              messageStates.changeStatus.get(msg.sequence) ??
                              "pending";
                            const statusClass =
                              status === "merged"
                                ? "border-kumo-success/30 bg-kumo-success-tint text-kumo-success"
                                : status === "reverted"
                                  ? "border-kumo-warning/30 bg-kumo-warning-tint text-kumo-warning"
                                  : "border-[var(--color-compute-100)]/30 bg-[var(--color-compute-200)] text-[var(--color-compute-100)]";
                            return (
                              <div
                                className={`rounded-lg border px-3 py-2 text-xs ${statusClass}`}
                              >
                                <div className="flex items-center justify-between gap-2 mb-1">
                                  <span className="flex items-center gap-1.5 font-medium italic flex-1 min-w-0 truncate">
                                    <span>📝</span>
                                    {msg.author.name} made changes
                                    {status === "merged" && (
                                      <span className="font-bold not-italic">
                                        ✓ merged
                                      </span>
                                    )}
                                    {status === "reverted" && (
                                      <span className="font-bold not-italic">
                                        ↩ reverted
                                      </span>
                                    )}
                                  </span>
                                  <span className="font-mono text-[11px] opacity-70 flex-shrink-0">
                                    {msg.timestamp.toLocaleTimeString([], {
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    })}
                                  </span>
                                </div>
                                {status === "pending" && (
                                  <div className="flex gap-2 justify-end mt-2">
                                    <Tooltip content="Merge this change and all previous changes into the mainline code." asChild>
                                      <button
                                        disabled={isAgentActive}
                                        onClick={() =>
                                          handleMergeChanges(msg.sequence)
                                        }
                                        className="px-2.5 py-1.5 text-[11px] font-medium rounded-md bg-kumo-brand text-kumo-inverse hover:bg-kumo-brand-hover disabled:opacity-40 transition-colors"
                                      >
                                        Merge
                                      </button>
                                    </Tooltip>
                                    <Tooltip content="Undo this and all later proposed changes." asChild>
                                      <button
                                        disabled={isAgentActive}
                                        onClick={() =>
                                          handleRevertChanges(msg.sequence)
                                        }
                                        className="px-2.5 py-1.5 text-[11px] font-medium rounded-md border border-kumo-danger/40 text-kumo-danger hover:bg-kumo-danger-tint disabled:opacity-40 transition-colors"
                                      >
                                        Revert
                                      </button>
                                    </Tooltip>
                                  </div>
                                )}
                              </div>
                            );
                          })()}

                        {/* ── merge / revert event ── */}
                        {(msg.type === "merge" || msg.type === "revert") &&
                          (() => {
                            const isMerge = msg.type === "merge";
                            const ts = isMerge
                              ? messageStates.mergeTimestamps.get(msg.sequence)
                              : messageStates.revertTimestamps.get(
                                  msg.sequence,
                                );
                            return (
                              <div
                                className={`flex items-center gap-2 text-xs italic opacity-60 ${isMerge ? "text-kumo-success" : "text-kumo-warning"}`}
                              >
                                <span>{isMerge ? "✅" : "↩️"}</span>
                                <span>
                                  {msg.author.name}{" "}
                                  {isMerge
                                    ? "merged all changes through"
                                    : "reverted changes from"}{" "}
                                  {ts ? ts.toLocaleString() : "unknown time"}
                                  {!isMerge ? " onward" : ""}
                                </span>
                                <span className="font-mono text-[11px] not-italic ml-auto">
                                  {msg.timestamp.toLocaleTimeString([], {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })}
                                </span>
                              </div>
                            );
                          })()}

                        {/* ── action / observation ── */}
                        {msg.type === "action" &&
                          (() => {
                            const log = msg.actionLog;
                            if (!log) return null;
                            const isAct = log.type === "action";
                            const state = log.state;
                            const open = expandedActions.has(msg.actionId);
                            const isProc = processingActions.has(msg.actionId);
                            const borderCls = !isAct
                              ? "border-kumo-line bg-kumo-elevated"
                              : state === "approved"
                                ? "border-kumo-success/30 bg-kumo-success-tint"
                                : state === "rejected"
                                  ? "border-kumo-danger/30 bg-kumo-danger-tint"
                                  : "border-[var(--color-compute-100)]/30 bg-[var(--color-compute-200)]";
                            const accentCls = !isAct
                              ? "text-kumo-subtle"
                              : state === "approved"
                                ? "text-kumo-success"
                                : state === "rejected"
                                  ? "text-kumo-danger"
                                  : "text-[var(--color-compute-100)]";
                            return (
                              <div
                                className={`rounded-lg border px-3 py-2 text-xs ${borderCls}`}
                              >
                                <div className="flex items-center gap-2">
                                  <button
                                    onClick={() =>
                                      toggleActionExpansion(msg.actionId)
                                    }
                                    className="flex-shrink-0"
                                  >
                                    <svg
                                      width="8"
                                      height="8"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2.5"
                                      className={`transition-transform ${open ? "rotate-90" : ""} text-kumo-subtle`}
                                    >
                                      <polyline points="9 18 15 12 9 6" />
                                    </svg>
                                  </button>
                                  <span className={`font-bold ${accentCls}`}>
                                    {isAct ? "Action" : "Observation"}
                                  </span>
                                  <span className="flex-1 min-w-0 truncate text-kumo-subtle">
                                    {log.bindingName && (
                                      <code className="font-mono bg-kumo-fill px-1 rounded mr-1">
                                        {log.bindingName}
                                      </code>
                                    )}
                                    {log.resourceUrl ? (
                                      <a
                                        href={log.resourceUrl}
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
                                  {isAct && state === "approved" && (
                                    <span className="font-bold text-kumo-success flex-shrink-0">
                                      ✓
                                    </span>
                                  )}
                                  {isAct && state === "rejected" && (
                                    <span className="font-bold text-kumo-danger flex-shrink-0">
                                      ✗
                                    </span>
                                  )}
                                  <span className="font-mono opacity-60 flex-shrink-0">
                                    {msg.timestamp.toLocaleTimeString([], {
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    })}
                                  </span>
                                </div>
                                <button
                                  onClick={() =>
                                    toggleActionExpansion(msg.actionId)
                                  }
                                  className="mt-1 pl-4 text-left text-kumo-default w-full"
                                >
                                  {log.description.title}
                                </button>
                                {open && (
                                  <div className="mt-2 pl-4 text-kumo-subtle whitespace-pre-wrap border-t border-kumo-line pt-2">
                                    {log.description.description}
                                  </div>
                                )}
                                {isAct && state === "pending" && (
                                  <div className="flex gap-2 justify-end mt-2">
                                    <button
                                      onClick={() =>
                                        handleApproveAction(msg.actionId)
                                      }
                                      disabled={isProc}
                                      className="px-2.5 py-1 text-[11px] font-medium rounded-md bg-kumo-brand text-kumo-inverse hover:bg-kumo-brand-hover disabled:opacity-40 transition-colors"
                                    >
                                      Approve
                                    </button>
                                    <button
                                      onClick={() =>
                                        handleRejectAction(msg.actionId)
                                      }
                                      disabled={isProc}
                                      className="px-2.5 py-1 text-[11px] font-medium rounded-md border border-kumo-danger/40 text-kumo-danger hover:bg-kumo-danger-tint disabled:opacity-40 transition-colors"
                                    >
                                      Reject
                                    </button>
                                  </div>
                                )}
                              </div>
                            );
                          })()}

                        {/* ── useGadget ── */}
                        {msg.type === "useGadget" && (
                          <div className="flex items-center gap-2 text-xs text-kumo-inactive italic">
                            <span className="w-3 h-px bg-kumo-fill flex-shrink-0" />
                            Agent used the Gadget
                            <span className="font-mono not-italic ml-auto opacity-60">
                              {msg.timestamp.toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                          </div>
                        )}

                        {/* ── error ── */}
                        {msg.type === "error" &&
                          (() => {
                            const key = `${msg.chatId}-${msg.sequence}`;
                            const isLast =
                              idx === currentMessages.length - 1 &&
                              !isAgentActive;
                            const open = isLast || expandedErrors.has(key);
                            return (
                              <div className="rounded-lg border border-kumo-danger/30 bg-kumo-danger-tint px-3 py-2 text-xs">
                                <div
                                  className="flex items-center justify-between gap-2 cursor-pointer"
                                  onClick={
                                    isLast
                                      ? undefined
                                      : () => toggleErrorExpansion(key)
                                  }
                                >
                                  <span className="flex items-center gap-1.5 font-bold text-kumo-danger">
                                    <svg
                                      width="13"
                                      height="13"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                    >
                                      <circle cx="12" cy="12" r="10" />
                                      <line x1="12" y1="8" x2="12" y2="12" />
                                      <line
                                        x1="12"
                                        y1="16"
                                        x2="12.01"
                                        y2="16"
                                      />
                                    </svg>
                                    {open ? "Error" : "Error — click to expand"}
                                  </span>
                                  <span className="font-mono opacity-60">
                                    {msg.timestamp.toLocaleTimeString([], {
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    })}
                                  </span>
                                </div>
                                {open && (
                                  <>
                                    <pre className="mt-2 text-kumo-danger font-mono whitespace-pre-wrap text-[11px] bg-kumo-base rounded p-2 max-h-48 overflow-auto">
                                      {msg.message}
                                    </pre>
                                    {isLast && (
                                      <div className="flex justify-end mt-2">
                                        <button
                                          onClick={handleRetry}
                                          disabled={selectedModel === null}
                                          className="px-2.5 py-1 text-[11px] font-medium rounded-md bg-kumo-danger text-kumo-inverse hover:opacity-90 disabled:opacity-40 transition-opacity flex items-center gap-1"
                                        >
                                          <svg
                                            width="11"
                                            height="11"
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="2.5"
                                          >
                                            <polyline points="1 4 1 10 7 10" />
                                            <path d="M3.51 15a9 9 0 1 0 .49-3.01" />
                                          </svg>
                                          Retry
                                        </button>
                                      </div>
                                    )}
                                  </>
                                )}
                              </div>
                            );
                          })()}

                        {/* ── agentCallback ── */}
                        {msg.type === "agentCallback" && (
                          <div className="rounded-lg border border-[var(--color-compute-100)]/30 bg-[var(--color-compute-200)] px-3 py-2 text-xs">
                            <div className="flex items-center gap-1.5 font-bold text-[var(--color-compute-100)] mb-1">
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
                            <pre className="font-mono text-kumo-subtle whitespace-pre-wrap text-[11px] max-h-24 overflow-auto">
                              {msg.argsSummary}
                            </pre>
                          </div>
                        )}
                      </div>
                    ))}

                    {/* Agent typing indicator */}
                    {isAgentActive && activeAgent && (
                      <div className="flex gap-3 items-start">
                        <AssistantAvatar />
                        <div className="flex-1 space-y-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold text-kumo-default">
                              {activeAgent.name}
                            </span>
                            <button
                              onClick={handleStop}
                              className="flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-md border border-kumo-danger/40 text-kumo-danger hover:bg-kumo-danger-tint transition-colors"
                            >
                              <svg
                                width="10"
                                height="10"
                                viewBox="0 0 24 24"
                                fill="currentColor"
                              >
                                <rect
                                  x="3"
                                  y="3"
                                  width="18"
                                  height="18"
                                  rx="2"
                                />
                              </svg>
                              Stop
                            </button>
                          </div>
                          {hasVisibleProvisionalContent &&
                          currentProvisionalState ? (
                            <div className="space-y-2">
                              {currentProvisionalState.reasoning &&
                                (() => {
                                  const messageKey = `stream-${selectedChatId ?? "none"}`;
                                  const isExpanded =
                                    expandedReasoning.has(messageKey);
                                  return (
                                    <div
                                      className={
                                        currentProvisionalState.text ||
                                        currentProvisionalState.toolCalls
                                          .length > 0
                                          ? "mb-3"
                                          : ""
                                      }
                                    >
                                      <div
                                        onClick={() =>
                                          toggleReasoningExpansion(messageKey)
                                        }
                                        className="flex items-center gap-2 text-xs text-kumo-inactive cursor-pointer"
                                      >
                                        <span className="font-mono">
                                          {isExpanded ? "▼" : "▶"}
                                        </span>
                                        <span className="font-bold italic">
                                          Reasoning
                                        </span>
                                      </div>
                                      {isExpanded && (
                                        <div className="mt-1 text-sm text-kumo-subtle whitespace-pre-wrap">
                                          {currentProvisionalState.reasoning}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })()}

                              {currentProvisionalState.text && (
                                <div
                                  className={`text-sm leading-relaxed text-kumo-default ${styles.markdownContent}`}
                                >
                                  <ReactMarkdown skipHtml={true}>
                                    {currentProvisionalState.text}
                                  </ReactMarkdown>
                                </div>
                              )}

                              {visibleProvisionalToolCalls.length > 0 && (
                                <div
                                  className={
                                    currentProvisionalState.text ? "mt-2" : ""
                                  }
                                >
                                  {visibleProvisionalToolCalls.map(
                                    (toolCall) => {
                                      const isExpanded = expandedToolCalls.has(
                                        toolCall.toolCallId,
                                      );
                                      return (
                                        <div
                                          key={`stream-tool-${toolCall.toolCallId}`}
                                          className={`text-xs p-2 px-3 rounded mt-1.5 font-mono border ${
                                            toolCall.error
                                              ? "bg-kumo-danger-tint border-kumo-danger/30"
                                              : "bg-kumo-elevated border-kumo-line"
                                          }`}
                                        >
                                          <div
                                            onClick={() =>
                                              toggleToolCallExpansion(
                                                toolCall.toolCallId,
                                              )
                                            }
                                            className="flex items-center gap-2 cursor-pointer select-none text-kumo-subtle"
                                          >
                                            <span className="text-[10px]">
                                              {isExpanded ? "▼" : "▶"}
                                            </span>
                                            <span className="font-bold">
                                              {toolCall.toolName ?? "tool"}
                                            </span>
                                            {toolCall.finished &&
                                              !toolCall.error && (
                                                <span className="ml-auto text-kumo-success font-bold">
                                                  done
                                                </span>
                                              )}
                                            {toolCall.error && (
                                              <span className="ml-auto text-kumo-danger font-bold">
                                                error
                                              </span>
                                            )}
                                          </div>
                                          {isExpanded && (
                                            <>
                                              {toolCall.code && (
                                                <>
                                                  <div className="mt-2 text-[11px] text-kumo-inactive font-bold">
                                                    Code:
                                                  </div>
                                                  <pre className="mt-1 mb-0 p-2 bg-kumo-base border border-kumo-line rounded-sm text-[11px] overflow-auto max-h-[300px] whitespace-pre-wrap break-words">
                                                    {toolCall.code}
                                                  </pre>
                                                </>
                                              )}
                                              {toolCall.output && (
                                                <>
                                                  <div className="mt-2 text-[11px] text-kumo-inactive font-bold">
                                                    Output:
                                                  </div>
                                                  <pre className="mt-1 mb-0 p-2 bg-kumo-elevated border border-kumo-line rounded-sm text-[11px] overflow-auto max-h-[300px] whitespace-pre-wrap break-words">
                                                    {toolCall.output}
                                                  </pre>
                                                </>
                                              )}
                                              {toolCall.error && (
                                                <div className="mt-2 p-2 bg-kumo-danger-tint border border-kumo-danger/30 rounded-sm text-kumo-danger text-[11px] whitespace-pre-wrap">
                                                  {toolCall.error}
                                                </div>
                                              )}
                                            </>
                                          )}
                                        </div>
                                      );
                                    },
                                  )}
                                </div>
                              )}

                              <div className="flex items-center gap-2 mt-2">
                                <div className="w-3 h-3 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
                                <span className="text-xs text-kumo-subtle">
                                  Streaming…
                                </span>
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-kumo-brand animate-bounce [animation-delay:0ms]" />
                              <span className="w-1.5 h-1.5 rounded-full bg-kumo-brand animate-bounce [animation-delay:150ms]" />
                              <span className="w-1.5 h-1.5 rounded-full bg-kumo-brand animate-bounce [animation-delay:300ms]" />
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    <div ref={messagesEndRef} />
                  </div>
                )}
              </div>

              {/* ── Bottom: proposed changes banner + input + cost ──────────────── */}
              <div
                className={`flex-shrink-0 ${sidebarMode ? "" : "border-t border-kumo-line"}`}
              >
                <div className={useConstrainedChatWidth ? "max-w-3xl mx-auto w-full" : ""}>
                  {/* Proposed changes banner */}
                  {(() => {
                    if (
                      !currentChatMetadata?.hasProposedChanges ||
                      isAgentActive
                    )
                      return null;

                    const { activeChanges } = messageStates;
                    if (activeChanges.length === 0) return null;
                    const lastActiveChange = [...currentMessages]
                      .reverse()
                      .find(
                        (m) =>
                          m.type === "changes" &&
                          messageStates.changeStatus.get(m.sequence) ===
                            "pending",
                      );
                    if (!lastActiveChange) return null;
                    return (
                      <div className="flex items-center gap-3 px-4 py-2.5 bg-[var(--color-compute-200)] border-b border-[var(--color-compute-100)]/20">
                        <span className="flex-1 text-xs text-[var(--color-compute-100)]">
                          Agent proposed changes
                        </span>
                        <Tooltip content="Merge all proposed changes into the mainline code." asChild>
                          <button
                            onClick={() =>
                              handleMergeChanges(lastActiveChange.sequence)
                            }
                            className="px-2.5 py-1.5 text-[11px] font-medium rounded-md bg-kumo-brand text-kumo-inverse hover:bg-kumo-brand-hover transition-colors flex items-center gap-1"
                          >
                            <svg
                              width="11"
                              height="11"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                            >
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                            Merge all
                          </button>
                        </Tooltip>
                      </div>
                    );
                  })()}

                  {/* Input */}
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
                  />

                  {/* Token / cost summary */}
                  {(currentChatMetadata?.totalTokens != null ||
                    currentChatMetadata?.totalCost != null) && (
                    <div className="flex items-center justify-end gap-4 px-4 pb-2 text-[11px] font-mono text-kumo-inactive">
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

      {/* Delete confirmation dialog */}
      <Dialog.Root
        role="alertdialog"
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <Dialog className="p-8" size="sm">
          <Dialog.Title className="text-lg font-semibold">
            Delete chat
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-kumo-subtle">
            Are you sure you want to delete &ldquo;{deleteTarget?.title}&rdquo;?
            This action cannot be undone.
          </Dialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close
              render={(props) => (
                <KumoButton
                  variant="secondary"
                  {...props}
                  disabled={isDeleting}
                >
                  Cancel
                </KumoButton>
              )}
            />
            <KumoButton
              variant="destructive"
              onClick={handleDeleteConfirm}
              loading={isDeleting}
            >
              Delete
            </KumoButton>
          </div>
        </Dialog>
      </Dialog.Root>
    </div>
  );
}

export default ChatInterface;
