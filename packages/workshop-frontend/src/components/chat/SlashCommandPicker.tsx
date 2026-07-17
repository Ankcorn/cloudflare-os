import { Tooltip } from "@cloudflare/kumo";
import { Terminal } from "@phosphor-icons/react";
import { RpcStub } from "capnweb";
import { createPortal } from "react-dom";
import {
  useCallback, useEffect, useId, useLayoutEffect, useRef, useState,
  type RefObject, type SetStateAction,
} from "react";
import type { Overseer, SlashCommandChoice } from "@gadgets/workshop-shared/api";
import {
  exactSlashCommandMatches, filterSlashCommandCatalog, parseSlashCommandInput,
  type ParsedSlashCommandInput,
} from "./slash-command-input";

type SlashCommandPopupLayout = {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
};

function computePopupLayout(anchor: HTMLElement): SlashCommandPopupLayout {
  let popup = { margin: 12, gap: 8, minHeight: 160, maxHeight: 360 };
  let rect = anchor.getBoundingClientRect();
  let viewportWidth = window.innerWidth;
  let viewportHeight = window.innerHeight;
  let width = Math.min(rect.width, viewportWidth - popup.margin * 2);
  let left = Math.min(
    Math.max(rect.left, popup.margin),
    viewportWidth - width - popup.margin,
  );
  let spaceAbove = rect.top - popup.margin - popup.gap;
  let spaceBelow = viewportHeight - rect.bottom - popup.margin - popup.gap;
  let openBelow = spaceBelow >= popup.minHeight || spaceBelow > spaceAbove;
  let available = Math.max(openBelow ? spaceBelow : spaceAbove, popup.minHeight);
  let maxHeight = Math.min(popup.maxHeight, available);
  return {
    left,
    width,
    maxHeight,
    ...(openBelow
      ? {top: rect.bottom + popup.gap}
      : {bottom: viewportHeight - rect.top + popup.gap}),
  };
}

export function useSlashCommandPicker({
  inputValue,
  selectedCommand,
  disabled,
  anchorRef,
  getOverseer,
  onSelect,
}: {
  inputValue: string;
  selectedCommand: SlashCommandChoice | null;
  disabled: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  getOverseer: () => Promise<RpcStub<Overseer>> | RpcStub<Overseer>;
  onSelect: (choice: SlashCommandChoice, tailStart: number) => void;
}) {
  const [choices, setChoices] = useState<SlashCommandChoice[]>([]);
  const [choicesQuery, setChoicesQuery] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissedInput, setDismissedInput] = useState<string | null>(null);
  const [explicitChoiceInput, setExplicitChoiceInput] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [layout, setLayout] = useState<SlashCommandPopupLayout | null>(null);
  // Catalog for this mounted Gadget editor. Loaded when the picker first opens and filtered locally.
  const catalogRef = useRef<SlashCommandChoice[] | null>(null);
  const catalogLoadRef = useRef<Promise<SlashCommandChoice[]> | null>(null);
  const catalogSourceRef = useRef(getOverseer);
  const popupRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const parsed = selectedCommand || disabled ? null : parseSlashCommandInput(inputValue);
  const open = parsed !== null && dismissedInput !== inputValue;
  const query = parsed?.query ?? "";
  const selectable = choicesQuery === query && !loading && error === null;
  const exactMatches = parsed && selectable
    ? exactSlashCommandMatches(catalogRef.current ?? choices, parsed)
    : [];
  const exactIndex = exactMatches.length === 1 ? choices.indexOf(exactMatches[0]) : -1;
  const requiresExplicitChoice = exactMatches.length > 1;
  const activeChoice = !requiresExplicitChoice || explicitChoiceInput === inputValue
    ? choices[index]
    : undefined;
  const selectIndex = (next: SetStateAction<number>) => {
    setIndex(next);
    setExplicitChoiceInput(inputValue);
  };
  if (catalogSourceRef.current !== getOverseer) {
    catalogSourceRef.current = getOverseer;
    catalogRef.current = null;
    catalogLoadRef.current = null;
  }

  const loadCatalog = useCallback(async () => {
    if (catalogRef.current) return catalogRef.current;
    if (catalogLoadRef.current) return catalogLoadRef.current;
    let source = getOverseer;
    let load = Promise.resolve(source()).then(overseer => overseer.listSlashCommands());
    catalogLoadRef.current = load;
    try {
      let catalog = await load;
      if (catalogSourceRef.current === source) catalogRef.current = catalog;
      return catalog;
    } finally {
      if (catalogLoadRef.current === load) catalogLoadRef.current = null;
    }
  }, [getOverseer]);

  const select = useCallback((choice: SlashCommandChoice) => {
    let current = parseSlashCommandInput(inputValue);
    onSelect(choice, current?.tailStart ?? 0);
    setChoices([]);
    setChoicesQuery(null);
    setDismissedInput(null);
  }, [inputValue, onSelect]);

  useEffect(() => {
    setExplicitChoiceInput(null);
  }, [inputValue]);

  const resolveExact = useCallback(async (current: ParsedSlashCommandInput) => {
    let catalog = await loadCatalog();
    let matches = exactSlashCommandMatches(catalog, current);
    return matches.length === 1 ? matches[0] : null;
  }, [loadCatalog]);

  useEffect(() => {
    if (!parsed) {
      setChoices([]);
      setChoicesQuery(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(catalogRef.current === null);
    setError(null);
    loadCatalog()
      .then((catalog) => {
        if (cancelled) return;
        setChoices(filterSlashCommandCatalog(catalog, query));
        setChoicesQuery(query);
        setIndex(0);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoading(false);
        setError(err instanceof Error ? err.message : `${err}`);
        console.error("Failed to list slash commands:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [loadCatalog, parsed !== null, query]);

  useEffect(() => {
    if (!parsed || !selectable || selectedCommand ||
        inputValue.length <= parsed.tokenEnd) return;
    let matches = exactSlashCommandMatches(catalogRef.current ?? [], parsed);
    if (matches.length === 1) select(matches[0]);
  }, [choices, inputValue, parsed, select, selectable, selectedCommand]);

  useEffect(() => {
    if (exactIndex >= 0) setIndex(exactIndex);
  }, [exactIndex, query]);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) {
      setLayout(null);
      return;
    }
    let update = () => {
      if (anchorRef.current) setLayout(computePopupLayout(anchorRef.current));
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, choices.length, error, loading, open]);

  useEffect(() => {
    if (!open) return;
    let onPointerDown = (event: PointerEvent) => {
      let target = event.target;
      if (!(target instanceof Node)) return;
      if (popupRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      setDismissedInput(inputValue);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [anchorRef, inputValue, open]);

  let popup = open && layout ? createPortal(
    <div
      ref={popupRef}
      className="fixed z-[1000] overflow-hidden rounded-xl border border-kumo-line bg-kumo-base shadow-[0_18px_50px_rgba(82,16,0,0.14)]"
      style={{
        left: layout.left,
        top: layout.top,
        bottom: layout.bottom,
        width: layout.width,
        maxHeight: layout.maxHeight,
      }}
    >
      <div className="flex items-center gap-2 border-b border-kumo-line bg-kumo-elevated px-3 py-2">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-kumo-brand/10 text-kumo-brand">
          <Terminal size={15} weight="duotone" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-kumo-default">Slash Commands</div>
          <div className="text-[11px] text-kumo-subtle">
            {error
              ? "Couldn’t load commands."
              : "Choose a command or type to filter."}
          </div>
        </div>
      </div>
      <div
        id={listboxId}
        role="listbox"
        aria-label="Slash commands"
        aria-busy={loading}
        className="overflow-auto p-1"
        style={{maxHeight: Math.max(80, layout.maxHeight - 52)}}
      >
        {loading && choices.length === 0 ? (
          <div className="px-3 py-3 text-sm text-kumo-subtle">Loading commands...</div>
        ) : choices.length > 0 ? (
          choices.map((choice, optionIndex) => (
            <Tooltip
              key={`${choice.selection.gatekeeperId}:${choice.selection.commandId}`}
              content={choice.description}
              asChild
            >
              <button
                id={`${listboxId}-option-${optionIndex}`}
                type="button"
                role="option"
                aria-selected={optionIndex === index && activeChoice !== undefined}
                disabled={!selectable}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left disabled:cursor-wait disabled:opacity-60 ${optionIndex === index ? "bg-kumo-tint" : "hover:bg-kumo-tint"}`}
                onMouseEnter={() => setIndex(optionIndex)}
                onClick={() => select(choice)}
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-kumo-brand/10 text-kumo-brand">
                  <Terminal size={15} weight="duotone" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-sm font-medium text-kumo-default">
                    /{choice.name}
                  </span>
                  <span className="block truncate text-xs text-kumo-subtle">
                    {choice.description}
                  </span>
                  <span className="block truncate text-[11px] text-kumo-subtle">
                    {choice.providerLabel}{choice.resourceLabel ? ` · ${choice.resourceLabel}` : ""}
                  </span>
                </span>
              </button>
            </Tooltip>
          ))
        ) : error ? (
          <div className="px-3 py-3">
            <div className="text-sm font-medium text-kumo-default">Couldn’t load commands</div>
            <div className="mt-1 text-xs leading-5 text-kumo-subtle">
              {error}
            </div>
          </div>
        ) : (
          <div className="px-3 py-3">
            <div className="text-sm font-medium text-kumo-default">No commands found</div>
            <div className="mt-1 text-xs leading-5 text-kumo-subtle">
              {query ? "No commands match your search." : "No commands are available."}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  ) : null;

  return {
    activeChoice,
    activeDescendant: open && selectable && activeChoice
      ? `${listboxId}-option-${index}`
      : undefined,
    choices,
    dismiss: () => setDismissedInput(inputValue),
    listboxId,
    open,
    popup,
    resolveExact,
    select,
    selectable,
    setIndex: selectIndex,
    status: open
      ? loading
        ? "Loading slash commands"
        : error
          ? `Slash commands unavailable: ${error}`
          : `${choices.length} slash command${choices.length === 1 ? "" : "s"} found`
      : "",
  };
}
