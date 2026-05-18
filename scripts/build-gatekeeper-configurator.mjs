import { watch } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import ts from "typescript";

const packageDir = resolve(process.argv[2] ?? ".");
const watchMode = process.argv.includes("--watch");
const quietMode = process.argv.includes("--quiet");
const configuratorDir = join(packageDir, "src", "configurator");
const generatedDir = join(packageDir, "src", "generated");

function logInfo(message) {
  if (!quietMode) console.log(message);
}

let capnwebBundle;

async function getCapnwebBundle() {
  if (capnwebBundle !== undefined) return capnwebBundle;
  capnwebBundle = await readFile(join(packageDir, "node_modules", "capnweb", "dist", "index.js"), "utf8");
  return capnwebBundle;
}

async function createConfiguratorHtml(moduleCode) {
  const capnwebBase64 = Buffer.from(`//# sourceURL=configurator-jsrpc.js\n${await getCapnwebBundle()}`, "utf8").toString("base64");
  const configuratorUIModuleCode = moduleCode.replace(
    /export\s+default\s+/,
    "globalThis.__configuratorUISpec = ",
  );
  const runtime = `//# sourceURL=configurator-runtime.js
import { RpcTarget, newMessagePortRpcSession } from "data:text/javascript;charset=utf-8;base64,${capnwebBase64}";

const root = document.getElementById("root");
let host;
let ui;
let spec;
let values = {};
let queryByName = {};
let validationErrorByName = {};
let touchedInputs = {};
let isRendering = false;
let suppressAutocompleteFocusRefresh = false;
let renderGeneration = 0;
let parentViewport = { iframeTop: 0, viewportHeight: 0 };
let Section;
let Field;
let TextInput;
let RadioCards;
let Autocomplete;

function childrenArray(children) {
  const items = Array.isArray(children) ? children : [children];
  return items.flat().filter(child => child !== null && child !== undefined && child !== false);
}

function Fragment({ children }) {
  return childrenArray(children);
}

function h(component, props, ...children) {
  if (typeof component === "string") return el(component, props ?? {}, childrenArray(children));
  return component({ ...(props ?? {}), children });
}

let lastPostedHeight = -1;
let lastPostedLayoutHeight = -1;
function postHeight() {
  const docTop = document.documentElement.getBoundingClientRect().top;
  const layoutRoot = document.getElementById("layout-root");
  const layoutBottom = layoutRoot ? layoutRoot.getBoundingClientRect().bottom - docTop : 0;
  const floatingBottom = Math.max(0, ...[...document.querySelectorAll("[data-floating-popup]")]
    .filter(node => node instanceof HTMLElement && node.style.display !== "none")
    .map(node => node.getBoundingClientRect().bottom - docTop));
  const height = Math.ceil(Math.max(layoutBottom, floatingBottom) + 8);
  const layoutHeight = Math.ceil(layoutBottom + 4);
  // Avoid flooding the parent with duplicate resize messages.
  if (height === lastPostedHeight && layoutHeight === lastPostedLayoutHeight) return;
  lastPostedHeight = height;
  lastPostedLayoutHeight = layoutHeight;
  host?.resize(height, layoutHeight);
}

let postHeightScheduled = false;
function postHeightAfterLayout() {
  if (postHeightScheduled) return;
  postHeightScheduled = true;
  requestAnimationFrame(() => {
    postHeightScheduled = false;
    postHeight();
  });
}

function getFocusState() {
  return document.activeElement instanceof HTMLInputElement ? {
    name: document.activeElement.getAttribute("data-configurator-input"),
    start: document.activeElement.selectionStart,
    end: document.activeElement.selectionEnd,
    direction: document.activeElement.selectionDirection,
  } : null;
}

let lastPostedReady;
function postSelectionState() {
  if (typeof spec?.isReady !== "function") return;
  const ready = Boolean(spec.isReady({ values }));
  if (ready === lastPostedReady) return;
  lastPostedReady = ready;
  host?.setSelectionReady(ready);
}

function setValues(patch) {
  const active = getFocusState();
  values = { ...values, ...patch };
  postSelectionState();
  render(active);
}

function clearFields(...names) {
  for (const name of names.flat()) delete queryByName[name];
}

function el(tag, props = {}, children = []) {
  const node = tag === "svg" || tag === "path"
    ? document.createElementNS("http://www.w3.org/2000/svg", tag)
    : document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "className") node.className = value;
    else if (key === "htmlFor") node.setAttribute("for", String(value));
    else if (key === "text") node.textContent = value;
    else if (key === "style" && value && typeof value === "object") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, "");
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === undefined || child === null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function optionText(value) {
  return typeof value === "string" ? value.slice(0, 240) : undefined;
}

function sanitizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.slice(0, 100).flatMap(option => {
    if (!option || typeof option !== "object") return [];
    const value = optionText(option.value);
    const title = optionText(option.title);
    if (!value || !title) return [];
    return [{ value, title, subtitle: optionText(option.subtitle), meta: optionText(option.meta) }];
  });
}

const components = {
  Section({ title = null, children }) {
    return el("section", { className: "section" }, [
      title ? el("h2", { className: "section-title", text: title }) : null,
      ...childrenArray(children),
    ]);
  },

  Field({ label, description, optional, children }) {
    return el("section", { className: "field" }, [
      el("div", { className: "field-header" }, [
        el("label", { className: "field-label", text: label }),
        optional ? el("span", { className: "field-optional", text: "Optional" }) : null,
      ]),
      description ? el("p", { className: "field-description", text: description }) : null,
      childrenArray(children)[0],
    ]);
  },

  TextInput({ name, value, placeholder, onChange, optional, disabled }) {
    const showError = validationErrorByName[name] && touchedInputs[name];
    const input = el("input", {
      className: showError ? "input no-icon invalid" : "input no-icon",
      "data-configurator-input": name,
      value: value || "",
      placeholder,
      disabled,
      autocomplete: "off",
      onblur: () => {
        if (isRendering) return;
        touchedInputs[name] = true;
        render(null);
      },
      oninput: event => {
        touchedInputs[name] = false;
        const nextValue = event.currentTarget.value;
        onChange(nextValue || (optional ? null : ""));
      },
    });
    return el("div", { className: "text-input", "data-name": name }, [
      input,
      showError ? el("p", { className: "input-error", text: validationErrorByName[name] }) : null,
    ]);
  },

  RadioCards({ value, options, onChange }) {
    return el("div", { className: "radio-cards" }, options.map(option => {
      const selected = option.value === value;
      return el("button", { type: "button", className: selected ? "radio-card selected" : "radio-card", onclick: () => onChange(option.value) }, [
        el("span", { className: "radio-title", text: option.title }),
        el("span", { className: "radio-description", text: option.description }),
      ]);
    }));
  },

  Autocomplete({ name, value, placeholder, loadOptions, onChange, optional, onClear, disabled }) {
    const queryName = name || placeholder;
    if (disabled && !value) queryByName[queryName] = "";
    const wrapper = el("div", { className: "autocomplete" });
    const inputWrapper = el("div", { className: "input-wrapper" });
    inputWrapper.append(el("span", { className: "search-icon" }, [
      el("svg", { viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": "true" }, [
        el("path", { d: "M7 2.25a4.75 4.75 0 1 0 0 9.5 4.75 4.75 0 0 0 0-9.5ZM1.25 7a5.75 5.75 0 1 1 10.21 3.63l3.2 3.2a.59.59 0 0 1-.83.83l-3.2-3.2A5.75 5.75 0 0 1 1.25 7Z", fill: "currentColor" }),
      ]),
    ]));
    const input = el("input", {
      className: "input",
      "data-configurator-input": queryName,
      value: queryByName[queryName] || "",
      placeholder,
      disabled,
      autocomplete: "off",
      role: "combobox",
      "aria-autocomplete": "list",
      "aria-expanded": "false",
      "aria-haspopup": "listbox",
    });
    const popup = el("div", { className: "autocomplete-popup", role: "listbox", "data-floating-popup": "", style: { display: "none" } });
    let requestId = 0;
    let debounceTimer;
    const generation = renderGeneration;

    function closePopup() {
      popup.style.display = "none";
      input.setAttribute("aria-expanded", "false");
      postHeightAfterLayout();
    }

    function applyPopupMaxHeight() {
      const POPUP_DEFAULT_MAX = 240;
      const POPUP_MIN = 96;
      const POPUP_MARGIN = 12;
      if (!parentViewport.viewportHeight) {
        popup.style.maxHeight = POPUP_DEFAULT_MAX + "px";
        return;
      }
      const inputRect = input.getBoundingClientRect();
      const inputBottomInParent = parentViewport.iframeTop + inputRect.bottom;
      const available = parentViewport.viewportHeight - inputBottomInParent - POPUP_MARGIN;
      const clamped = Math.max(POPUP_MIN, Math.min(POPUP_DEFAULT_MAX, available));
      popup.style.maxHeight = clamped + "px";
      postHeightAfterLayout();
    }

    popup.addEventListener("__viewport-changed", applyPopupMaxHeight);
    popup.addEventListener("__force-close", () => {
      closePopup();
      input.blur();
    });

    function renderPopup({ loading = false, error = null, options = [] }) {
      if (generation !== renderGeneration) return;
      popup.replaceChildren();
      popup.style.display = "block";
      input.setAttribute("aria-expanded", "true");
      applyPopupMaxHeight();
      if (loading) {
        popup.append(el("div", { className: "autocomplete-empty", text: "Loading..." }));
      } else if (error) {
        popup.append(el("div", { className: "autocomplete-empty", text: error }));
      } else if (options.length === 0) {
        popup.append(el("div", { className: "autocomplete-empty", text: "No matches." }));
      } else {
        for (const option of options) {
          popup.append(el("button", {
            type: "button",
            role: "option",
            className: "autocomplete-option",
            onmousedown: event => event.preventDefault(),
            onclick: () => {
              queryByName[queryName] = option.title;
              input.value = option.title;
              suppressAutocompleteFocusRefresh = true;
              onChange(option.value);
              closePopup();
            },
          }, [
            el("span", { className: "autocomplete-option-main" }, [
              el("span", { className: "autocomplete-option-title", text: option.title }),
              option.subtitle ? el("span", { className: "autocomplete-option-subtitle", text: option.subtitle }) : null,
            ]),
            option.meta ? el("span", { className: "autocomplete-option-meta", text: option.meta }) : null,
          ]));
        }
      }
      postHeightAfterLayout();
    }

    async function refreshNow() {
      if (generation !== renderGeneration || disabled) return;
      const currentRequest = ++requestId;
      renderPopup({ loading: true });
      try {
        const options = sanitizeOptions(await loadOptions(input.value));
        if (currentRequest !== requestId) return;
        renderPopup({ options });
      } catch (error) {
        if (currentRequest !== requestId) return;
        renderPopup({ error: error?.message || "Could not load options." });
      }
    }

    function refresh() {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(refreshNow, 180);
    }

    input.addEventListener("input", () => {
      if (disabled) return;
      queryByName[queryName] = input.value;
      if (value) onChange(null);
      refresh();
    });
    input.addEventListener("focus", () => {
      if (suppressAutocompleteFocusRefresh) {
        suppressAutocompleteFocusRefresh = false;
        return;
      }
      refreshNow();
    });
    input.addEventListener("blur", () => setTimeout(closePopup, 120));
    inputWrapper.append(input);
    if ((value || queryByName[queryName]) && !disabled) {
      inputWrapper.append(el("button", {
        type: "button",
        className: "clear-button",
        "aria-label": "Clear",
        onclick: () => {
          queryByName[queryName] = "";
          input.value = "";
          suppressAutocompleteFocusRefresh = true;
          if (onClear) onClear();
          else onChange(null);
          closePopup();
        },
      }, "×"));
    }
    wrapper.append(inputWrapper, popup);
    return wrapper;
  },
};

Section = components.Section;
Field = components.Field;
TextInput = components.TextInput;
RadioCards = components.RadioCards;
Autocomplete = components.Autocomplete;

function render(focusState = undefined) {
  if (!root || !spec) return;
  if (focusState === undefined) focusState = getFocusState();
  renderGeneration++;
  isRendering = true;
  root.replaceChildren(el("div", { id: "layout-root" }, [
    spec.render({ ui, values, setValues, clearFields, components }),
  ]));
  isRendering = false;
  if (focusState?.name) {
    const input = root.querySelector('[data-configurator-input="' + CSS.escape(focusState.name) + '"]');
    if (input instanceof HTMLInputElement) {
      input.focus();
      if (focusState.start !== null && focusState.end !== null) {
        input.setSelectionRange(Math.min(focusState.start, input.value.length), Math.min(focusState.end, input.value.length), focusState.direction ?? "none");
      }
    }
  }
  postSelectionState();
  postHeightAfterLayout();
}

class ResourceConfiguratorIframe extends RpcTarget {
  async collectResourceUrl() {
    const resourceUrl = await spec?.resourceUrl?.({ values, ui });
    if (typeof resourceUrl !== "string" || resourceUrl.length === 0) {
      throw new Error("Configurator did not provide a resource URL.");
    }
    return resourceUrl;
  }

  updateViewport(iframeTop, viewportHeight) {
    if (typeof iframeTop !== "number" || typeof viewportHeight !== "number") return;
    parentViewport = { iframeTop, viewportHeight };
    for (const popup of document.querySelectorAll("[data-floating-popup]")) {
      if (popup instanceof HTMLElement && popup.style.display !== "none") {
        popup.dispatchEvent(new Event("__viewport-changed"));
      }
    }
  }

  windowResized() {
    for (const popup of document.querySelectorAll("[data-floating-popup]")) {
      if (popup instanceof HTMLElement && popup.style.display !== "none") {
        popup.dispatchEvent(new Event("__force-close"));
      }
    }
  }
}

async function main() {
  const { port1, port2 } = new MessageChannel();
  window.parent.postMessage({ type: "handshake" }, "*", [port2]);
  host = newMessagePortRpcSession(port1, new ResourceConfiguratorIframe());
  ui = host.gatekeeper;

  Object.assign(globalThis, { h, Fragment, Section, Field, TextInput, RadioCards, Autocomplete });
  new Function(${JSON.stringify(`${configuratorUIModuleCode}\n//# sourceURL=configurator-ui-module.js`)})();

  spec = globalThis.__configuratorUISpec;
  if (!spec) throw new Error("Configurator UI module did not define a configurator UI.");
  values = { ...(spec.initial || {}) };
  postSelectionState();
  render();
}

main().catch(error => {
  root?.replaceChildren(el("div", { className: "error", text: error?.stack || String(error) }));
  postHeightAfterLayout();
});

new ResizeObserver(postHeight).observe(document.documentElement);

// Forward wheel/touch scrolls to the parent so the user can scroll the host modal even when the
// cursor is over the iframe. We skip events that originate inside an internally-scrollable
// element (e.g. an open autocomplete popup) so those scroll their own content first.
function isInsideInternalScroller(target) {
  for (let node = target instanceof Element ? target : null; node; node = node.parentElement) {
    if (node.hasAttribute && node.hasAttribute("data-floating-popup") && node.style.display !== "none") {
      if (node.scrollHeight > node.clientHeight) return true;
    }
  }
  return false;
}

window.addEventListener("wheel", event => {
  if (isInsideInternalScroller(event.target)) return;
  forwardScroll(event.deltaX, event.deltaY);
}, { passive: true });

let pendingScrollX = 0;
let pendingScrollY = 0;
let scrollForwardScheduled = false;
function forwardScroll(deltaX, deltaY) {
  pendingScrollX += deltaX;
  pendingScrollY += deltaY;
  if (scrollForwardScheduled) return;
  scrollForwardScheduled = true;
  requestAnimationFrame(() => {
    scrollForwardScheduled = false;
    const deltaX = pendingScrollX;
    const deltaY = pendingScrollY;
    pendingScrollX = 0;
    pendingScrollY = 0;
    if (deltaX || deltaY) host?.forwardScroll(deltaX, deltaY);
  });
}

let lastTouchY = 0;
let lastTouchX = 0;
window.addEventListener("touchstart", event => {
  const touch = event.touches[0];
  if (!touch) return;
  lastTouchY = touch.clientY;
  lastTouchX = touch.clientX;
}, { passive: true });
window.addEventListener("touchmove", event => {
  const touch = event.touches[0];
  if (!touch) return;
  if (isInsideInternalScroller(event.target)) {
    lastTouchY = touch.clientY;
    lastTouchX = touch.clientX;
    return;
  }
  const deltaY = lastTouchY - touch.clientY;
  const deltaX = lastTouchX - touch.clientX;
  lastTouchY = touch.clientY;
  lastTouchX = touch.clientX;
  forwardScroll(deltaX, deltaY);
}, { passive: true });
`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; script-src data: 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; media-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'none'; navigate-to 'none';">
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    html, body { margin: 0; overflow: visible; background: transparent; color: var(--color-kumo-default, #2f261f); font-size: 13px; }
    * { box-sizing: border-box; }
    #root { padding: 2px 2px 4px; }
    .section { display: grid; gap: 12px; }
    .section-title { margin: 0; font-size: 12px; line-height: 16px; font-weight: 600; color: var(--color-kumo-default, #2f261f); }
    .field { display: grid; gap: 0; position: relative; }
    .field-header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 2px; }
    .field-label { font-size: 12px; line-height: 16px; font-weight: 500; color: var(--color-kumo-default, #2f261f); }
    .field-optional { font-size: 12px; line-height: 16px; font-weight: 400; color: var(--color-kumo-subtle, #7d746c); }
    .field-description { margin: 0 0 6px; font-size: 12px; line-height: 16px; font-weight: 400; color: var(--color-kumo-subtle, #7d746c); }
    .input-wrapper { position: relative; }
    .search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); display: flex; align-items: center; justify-content: center; color: var(--color-kumo-inactive, #a59b92); pointer-events: none; line-height: 0; }
    .input { display: block; width: 100%; height: 36px; border: 1px solid var(--color-kumo-line, #ded7d0); border-radius: 8px; padding: 8px 10px 8px 30px; background: var(--color-kumo-base, #fff); color: inherit; outline: none; font: inherit; font-size: 13px; line-height: 18px; letter-spacing: -0.25px; }
    .input.no-icon { padding-left: 10px; }
    .input-wrapper:has(.clear-button) .input { padding-right: 34px; }
    .input:focus { border-color: var(--color-kumo-ring, #ff6a00); box-shadow: 0 0 0 2px rgb(255 106 0 / 12%); }
    .input.invalid { border-color: var(--color-kumo-danger, #c2410c); box-shadow: 0 0 0 2px rgb(194 65 12 / 10%); }
    .input:disabled { background: var(--color-kumo-elevated, #f8f5f1); color: var(--color-kumo-subtle, #7d746c); cursor: not-allowed; }
    .input-error { margin: 4px 0 0; font-size: 12px; line-height: 16px; color: var(--color-kumo-danger, #c2410c); }
    .clear-button { position: absolute; right: 9px; top: 50%; transform: translateY(-55%); display: flex; height: 18px; width: 18px; align-items: center; justify-content: center; border: 0; background: transparent; color: var(--color-kumo-subtle, #7d746c); font: inherit; font-size: 16px; font-weight: 300; line-height: 16px; cursor: pointer; opacity: 0.72; }
    .autocomplete { position: relative; }
    .autocomplete-popup { position: absolute; left: 0; right: 0; top: calc(100% + 6px); z-index: 10; max-height: 240px; overflow: auto; border: 1px solid var(--color-kumo-line, #ded7d0); border-radius: 8px; background: var(--color-kumo-base, #fff); box-shadow: 0 2px 6px rgb(0 0 0 / 6%); }
    .autocomplete-empty { padding: 8px 10px; font-size: 12px; line-height: 16px; color: var(--color-kumo-subtle, #7d746c); }
    .autocomplete-option { display: flex; min-height: 32px; width: 100%; align-items: center; gap: 8px; border: 0; border-top: 1px solid var(--color-kumo-line, #ded7d0); padding: 6px 8px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
    .autocomplete-option:first-child { border-top: 0; }
    .autocomplete-option:hover { background: var(--color-kumo-elevated, #f8f5f1); }
    .autocomplete-option-main { display: flex; min-width: 0; flex: 1; align-items: baseline; gap: 6px; }
    .autocomplete-option-title { min-width: 0; max-width: 72%; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .autocomplete-option-subtitle, .autocomplete-option-meta { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-kumo-subtle, #7d746c); font-size: 12px; }
    .autocomplete-option-subtitle { flex: 1; }
    .autocomplete-option-meta { flex-shrink: 0; }
    .radio-cards { display: grid; gap: 8px; }
    .radio-card { display: grid; gap: 2px; width: 100%; border: 1px solid var(--color-kumo-line, #ded7d0); border-radius: 10px; padding: 10px; background: var(--color-kumo-base, #fff); color: inherit; text-align: left; cursor: pointer; }
    .radio-card:hover { background: var(--color-kumo-elevated, #f8f5f1); }
    .radio-card.selected { border-color: var(--color-kumo-ring, #ff6a00); background: var(--color-kumo-tint, #fff3eb); }
    .radio-title { font-weight: 600; }
    .radio-description { color: var(--color-kumo-subtle, #7d746c); font-size: 12px; line-height: 16px; }
    .error { white-space: pre-wrap; color: #9f1239; border: 1px solid #fecdd3; border-radius: 10px; padding: 10px; background: #fff1f2; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="data:text/javascript;charset=utf-8,${encodeURIComponent(runtime)}"></script>
</body>
</html>`.trim();
}

async function buildConfiguratorUIs() {
  let configuratorUIs;
  try {
    configuratorUIs = (await readdir(configuratorDir))
      .filter(name => name.endsWith(".tsx"))
      .sort();
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: false };
    throw error;
  }

  await mkdir(generatedDir, { recursive: true });

  let writtenCount = 0;
  for (const configuratorUI of configuratorUIs) {
    const source = await readFile(join(configuratorDir, configuratorUI), "utf8");
    const diagnostics = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.React,
        jsxFactory: "h",
        jsxFragmentFactory: "Fragment",
        removeComments: false,
      },
      fileName: configuratorUI,
      reportDiagnostics: true,
    });
    if (diagnostics.diagnostics?.length) {
      const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics.diagnostics, {
        getCanonicalFileName: fileName => fileName,
        getCurrentDirectory: () => packageDir,
        getNewLine: () => "\n",
      });
      throw new Error(formatted);
    }

    const outputName = basename(configuratorUI, ".tsx") + ".txt";
    const outputText = diagnostics.outputText
      .replace(/^import\s+[^;]+from\s+["']@gadgets\/configurator-ui["'];\s*\n?/gm, "")
      .replace(/^import\s+type\s+[^;]+;\s*\n?/gm, "")
      .replace(/^export\s+{};\s*\n?/gm, "");
    if (/^\s*import\s/m.test(outputText) || /^\s*export\s+.*\sfrom\s/m.test(outputText)) {
      throw new Error(
        `${configuratorUI} generated unsupported import or re-export statements. ` +
        `Configurator UI modules must be self-contained after generation.`);
    }

    const outputPath = join(generatedDir, outputName);
    const html = await createConfiguratorHtml(outputText);
    const newContent =
      `<!-- Generated by scripts/build-gatekeeper-configurator.mjs from src/configurator/${configuratorUI}. Do not edit. -->\n` +
      html;

    // Skip writes when content is unchanged so editors / file watchers don't see spurious changes.
    let existing;
    try {
      existing = await readFile(outputPath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (existing === newContent) continue;

    await writeFile(outputPath, newContent);
    writtenCount++;
  }

  return { ok: true, total: configuratorUIs.length, writtenCount };
}

const initial = await buildConfiguratorUIs();
if (!initial.ok) process.exit(0);

if (initial.writtenCount > 0) {
  console.log(`generated ${initial.writtenCount} configurator UI module${initial.writtenCount === 1 ? "" : "s"}: ${packageDir}`);
} else {
  logInfo(`configurator UI up-to-date (${initial.total} module${initial.total === 1 ? "" : "s"}): ${packageDir}`);
}

if (!watchMode) process.exit(0);

let timer;
watch(configuratorDir, { persistent: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    buildConfiguratorUIs().then(result => {
      if (result.ok && result.writtenCount > 0) {
        console.log(`generated ${result.writtenCount} configurator UI module${result.writtenCount === 1 ? "" : "s"}: ${packageDir}`);
      }
    }).catch(error => {
      console.error(`failed to generate configurator UI modules: ${packageDir}`);
      console.error(error);
    });
  }, 50);
});

logInfo(`watching configurator UI modules: ${configuratorDir}`);

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
