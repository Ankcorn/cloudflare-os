// These functions run in the remote browser via Puppeteer's page.evaluate().
// While they are imported by the Worker, they never run in the Worker, and are
// typed for the browser environment.

declare global {
  /** Sends a Cap'n Web RPC message from the Worker to the browser-side session. */
  var __workshopExportSendToBrowser: (message: string) => void;
  /** Receives the next Cap'n Web RPC message from the browser-side session. */
  var __workshopExportReceiveFromBrowser: () => Promise<string>;
  /** Settles when the Gadget client module has finished loading. */
  var __workshopExportModulePromise: Promise<Record<string, unknown>>;
  /** Sanitizes a complete HTML document inside Puppeteer's isolated realm. */
  var __workshopExportSanitizeHtml: (html: string) => string;
}

/** Delivers one Cap'n Web RPC message to the browser-side session. */
export function sendToBrowser(message: string): void {
  globalThis.__workshopExportSendToBrowser(message);
}

/** Receives one Cap'n Web RPC message from the browser-side session. */
export function receiveFromBrowser(): Promise<string> {
  return globalThis.__workshopExportReceiveFromBrowser();
}

/** Waits for the Gadget client module to finish evaluating in the main world. */
export async function waitForClientModule(): Promise<void> {
  await globalThis.__workshopExportModulePromise;
}

/** Waits until the rendered DOM has remained unchanged for the requested interval. */
export function waitForDomSettled(quietMs: number): Promise<void> {
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout>;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(finish, quietMs);
    });
    function finish() {
      observer.disconnect();
      resolve();
    }
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    timer = setTimeout(finish, quietMs);
  });
}

/** Assigns the title used by PDF viewers and the static HTML snapshot. */
export function setDocumentTitle(title: string): void {
  document.title = title;
}

/** Creates an inert, self-contained HTML snapshot of the rendered Gadget. */
export function createStaticHtmlSnapshot(csp: string): string {
  const html = globalThis.__workshopExportSanitizeHtml(
    `<!DOCTYPE html>\n${document.documentElement.outerHTML}`,
  );
  const sanitized = new DOMParser().parseFromString(html, "text/html");
  for (const refresh of sanitized.querySelectorAll('meta[http-equiv="refresh" i]')) {
    refresh.remove();
  }
  const policy = sanitized.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = csp;
  const charset = sanitized.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  sanitized.head.prepend(charset, policy);
  return `<!DOCTYPE html>\n${sanitized.documentElement.outerHTML}`;
}
