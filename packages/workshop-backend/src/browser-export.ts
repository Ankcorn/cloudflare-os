import { launch, type Page } from "@cloudflare/puppeteer";
import { RpcSession, type RpcTransport } from "capnweb";
import { createLogger } from "@gadgets/backend-utils/logger";
import type { GadgetScreenshotOptions } from "@gadgets/workshop-shared/api";
import BROWSER_EXPORT_RUNTIME from "./generated/browser-export-runtime.txt";

type BrowserExportLogFields = {
  event?: string;
  error?: unknown;
};

const logger = createLogger<BrowserExportLogFields>({ component: "workshop.browser-export" });

/** Wall-clock budget covering launch, rendering, and delivery of the entire export. */
const MAX_EXPORT_DURATION_MS = 30_000;
/** Largest export the Workshop will stream. Enforced while streaming, never buffered in full. */
const MAX_EXPORT_BYTES = 100 * 1024 * 1024;
/** Largest PNG returned in memory by a screenshot export. */
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
/** Quiet period indicating that the client has finished its initial DOM updates. */
const DOM_SETTLE_MS = 250;
/** Budget for releasing the browser session once an export has settled. */
const BROWSER_CLOSE_TIMEOUT_MS = 10_000;
/** Maximum number of pending Worker-to-browser RPC messages. */
const MAX_PENDING_RPC_SENDS = 1024;
/** Maximum total string length across all pending Worker-to-browser RPC messages. */
const MAX_PENDING_RPC_SEND_CHARS = 32 * 1024 * 1024;
/** CSP ignores `sandbox` in a meta tag, so serve the document through interception with a header. */
const EXPORT_DOCUMENT_URL = "https://gadget-export.invalid/";
// TODO: CSP and request interception do not cover WebRTC/STUN. The same gap exists for Gadgets
// running inside an iframe in the user's browser. We should close the gap in both places. For now,
// extending the same gap to remotely-rendered gadgets is acceptable.
const EXPORT_DOCUMENT_CSP = "default-src 'none'; frame-src 'none'; script-src data:; " +
  "style-src data: 'unsafe-inline'; img-src data: blob:; media-src data: blob:; " +
  "font-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; " +
  "connect-src 'none'; sandbox allow-scripts;";

function createDeadline(ms: number, message: string) {
  let expired = Promise.withResolvers<never>();
  let timer = setTimeout(() => expired.reject(new Error(message)), ms);
  expired.promise.catch(() => {});

  return {
    race<T>(work: Promise<T>): Promise<T> {
      return Promise.race([work, expired.promise]);
    },
    clear(): void {
      clearTimeout(timer);
    },
    onExpire(callback: () => Promise<void>): void {
      void expired.promise.catch(callback).catch(() => {});
    },
  };
}

async function closeBrowser(browser: Awaited<ReturnType<typeof launch>>): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      browser.close(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Closing the export browser timed out.")),
            BROWSER_CLOSE_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    logger.warn("failed to close browser after gadget export", {
      event: "gadget.export.browser.close.failed",
      error,
    });
  } finally {
    clearTimeout(timer!);
  }
}

/** Ordered CDP transport for the RPC session between the Worker and remote browser. */
export class BrowserRpcTransport implements RpcTransport {
  #sendChain = Promise.resolve();
  #pendingSendCount = 0;
  #pendingSendChars = 0;
  #abortReason = Promise.withResolvers<Error>();

  constructor(private page: Page) {}

  send(message: string): Promise<void> {
    if (this.#pendingSendCount >= MAX_PENDING_RPC_SENDS ||
        message.length > MAX_PENDING_RPC_SEND_CHARS - this.#pendingSendChars) {
      let error = new Error("The Gadget export RPC send queue overflowed.");
      this.abort(error);
      return Promise.reject(error);
    }

    ++this.#pendingSendCount;
    this.#pendingSendChars += message.length;
    let delivered = this.#sendChain.then(() =>
      this.#untilAborted(this.page.evaluate(
        text => globalThis.__workshopExportSendToBrowser(text),
        message,
      )));
    let settled = delivered.finally(() => {
      --this.#pendingSendCount;
      this.#pendingSendChars -= message.length;
    });
    this.#sendChain = settled.catch(() => {});
    return settled;
  }

  async receive(): Promise<string> {
    let message = await this.#untilAborted(
      this.page.evaluate(() => globalThis.__workshopExportReceiveFromBrowser()),
    );
    if (typeof message !== "string") {
      throw new Error("The Gadget export RPC message from the browser was not a string.");
    }
    return message;
  }

  /**
   * Rejects in-flight and queued operations rather than only marking a flag, so a stalled page
   * cannot keep the RPC session alive after the export has settled.
   */
  abort(reason: unknown): void {
    this.#abortReason.resolve(reason instanceof Error ? reason : new Error(String(reason)));
  }

  #untilAborted<T>(work: Promise<T>): Promise<T> {
    return Promise.race([
      work,
      this.#abortReason.promise.then(reason => { throw reason; }),
    ]);
  }
}

function scriptUrl(source: string): string {
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
}

function makeExportHtml(clientCode: string): string {
  let clientPrefix = String.raw`//# sourceURL=client.js
const { gadget, RpcStub, RpcTarget } = globalThis.__workshopExportRuntime;
delete globalThis.__workshopExportRuntime;
`;
  let clientUrl = scriptUrl(clientPrefix + clientCode);
  let runtimeUrl = scriptUrl(
      `globalThis.__workshopExportClientUrl = ${JSON.stringify(clientUrl)};\n` +
      BROWSER_EXPORT_RUNTIME);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
</head>
<body>
  <script src="${runtimeUrl}"></script>
</body>
</html>`;
}

type ExportSession = {
  page: Page;
  deadline: ReturnType<typeof createDeadline>;
  release(): Promise<void>;
};

async function initializeExport(
  browserBinding: BrowserRun,
  clientCode: string,
  gadget: Disposable,
  viewport?: GadgetScreenshotOptions,
): Promise<ExportSession> {
  let deadline = createDeadline(MAX_EXPORT_DURATION_MS, "Browser export timed out.");
  let launchPromise = launch(browserBinding);
  let browser: Awaited<ReturnType<typeof launch>>;
  try {
    browser = await deadline.race(launchPromise);
  } catch (error) {
    deadline.clear();
    gadget[Symbol.dispose]();
    // A timed-out launch cannot be cancelled. Close it if it eventually produces a browser.
    void launchPromise.then(closeBrowser, () => {});
    logger.warn("failed to launch browser for gadget export", {
      event: "gadget.export.browser.launch.failed",
      error,
    });
    throw error;
  }

  let sessionCloser: Disposable | undefined;
  let releasePromise: Promise<void> | undefined;
  let release = () => {
    if (!releasePromise) {
      releasePromise = (async () => {
        deadline.clear();
        if (sessionCloser) {
          sessionCloser[Symbol.dispose]();
        } else {
          // RpcSession takes ownership of its local main object. Before it exists, ownership remains
          // here and setup failures must release the stub directly.
          gadget[Symbol.dispose]();
        }
        await closeBrowser(browser);
      })();
    }
    return releasePromise;
  };
  deadline.onExpire(release);

  try {
    let page = await deadline.race((async () => {
      let newPage = await browser.newPage();
      if (viewport) {
        await newPage.setViewport({...viewport, deviceScaleFactor: 1});
      }
      await newPage.setRequestInterception(true);
      newPage.on("request", (request) => {
        let url = request.url();
        if (url === EXPORT_DOCUMENT_URL && request.isNavigationRequest() &&
            request.frame() === newPage.mainFrame()) {
          void request.respond({
            status: 200,
            contentType: "text/html",
            headers: {"Content-Security-Policy": EXPORT_DOCUMENT_CSP},
            body: makeExportHtml(clientCode),
          });
        } else if (url === "about:blank" || url.startsWith("data:") || url.startsWith("blob:")) {
          void request.continue();
        } else {
          void request.abort();
        }
      });
      await newPage.goto(EXPORT_DOCUMENT_URL, { waitUntil: "load" });
      let transport = new BrowserRpcTransport(newPage);
      newPage.on("close", () => transport.abort(new Error("Browser page closed.")));
      let rpcSession = new RpcSession(transport, gadget);
      sessionCloser = rpcSession.getRemoteMain();
      await waitForDomSettled(newPage);
      return newPage;
    })());
    return {page, deadline, release};
  } catch (error) {
    // Deliberately omits the caught value: failures here can carry Gadget-authored exception text,
    // which must not reach logs or the external issue Reporter.
    logger.warn("failed to render gadget export", { event: "gadget.export.render.failed" });
    await release();
    throw error;
  }
}

/** Limits the size of the exported file streamed back to the client. */
export function limitStream(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  let total = 0;
  let limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        controller.error(new Error(`Gadget exports may not exceed ${maxBytes} bytes.`));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  void source.pipeTo(limiter.writable).catch(() => {});
  return limiter.readable;
}

/** Releases the browser session once the export stream completes, fails, or is cancelled. */
function releaseWhenSettled(
  source: ReadableStream<Uint8Array>,
  release: () => Promise<void>,
): ReadableStream<Uint8Array> {
  let reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        await release();
        throw error;
      }
      if (chunk.done) {
        await release();
        controller.close();
      } else {
        controller.enqueue(chunk.value);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
      await release();
    },
  });
}

async function waitForDomSettled(page: Page): Promise<void> {
  await page.evaluate(async (quietMs: number) => {
    const browser = globalThis as unknown as {
      __workshopExportModulePromise: Promise<Record<string, unknown>>;
      document: { documentElement: unknown };
      MutationObserver: new(callback: () => void) => {
        observe(target: unknown, options: Record<string, boolean>): void;
        disconnect(): void;
      };
    };
    // Make sure that client module has been loaded before watching DOM.
    await browser.__workshopExportModulePromise;
    await new Promise<void>(resolve => {
      let timer: ReturnType<typeof setTimeout>;
      let observer = new browser.MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(finish, quietMs);
      });
      function finish() {
        observer.disconnect();
        resolve();
      }
      observer.observe(browser.document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      timer = setTimeout(finish, quietMs);
    });
  }, DOM_SETTLE_MS);
  await page.evaluate(async () => {
    const browser = globalThis as unknown as {
      document: {
        fonts?: { ready: Promise<void> };
        querySelectorAll(selectors: string): ArrayLike<{
          complete: boolean;
          addEventListener(type: string, listener: () => void, options: { once: boolean }): void;
          decode?: () => Promise<void>;
        }>;
      };
    };
    let images = Array.from(browser.document.querySelectorAll("img"));
    await Promise.all([
      browser.document.fonts?.ready ?? Promise.resolve(),
      ...images.map(async image => {
        if (!image.complete) {
          await new Promise<void>(resolve => {
            image.addEventListener("load", resolve, {once: true});
            image.addEventListener("error", resolve, {once: true});
            // Avoid missing an event if the image completed while listeners were attached.
            if (image.complete) resolve();
          });
        }
        await image.decode?.().catch(() => {});
      }),
    ]);
  });
}

/**
 * Renders a Gadget's UI as PDF in a remote browser and streams the bytes back.
 *
 * Takes ownership of `gadget` and disposes it once the export settles. The
 * returned stream must be consumed or cancelled: the browser session stays open
 * until it settles or times out.
 */
export async function renderGadgetPdf(
  browserBinding: BrowserRun,
  clientCode: string,
  documentTitle: string,
  gadget: Disposable,
): Promise<ReadableStream<Uint8Array>> {
  let {page, deadline, release} = await initializeExport(browserBinding, clientCode, gadget);

  try {
    let source = await deadline.race((async () => {
      await page.emulateMediaType("print");
      await page.evaluate(title => {
        let browser = globalThis as unknown as { document: { title: string } };
        browser.document.title = title;
      }, documentTitle);
      return page.createPDFStream({
        preferCSSPageSize: true,
        printBackground: true,
        waitForFonts: true,
      });
    })());
    return releaseWhenSettled(limitStream(source, MAX_EXPORT_BYTES), release);
  } catch (error) {
    // Deliberately omits the caught value: failures here can carry Gadget-authored exception text,
    // which must not reach logs or the external issue Reporter.
    logger.warn("failed to render gadget export", { event: "gadget.export.render.failed" });
    await release();
    throw error;
  }
}

function validateScreenshotOptions(options: GadgetScreenshotOptions): void {
  if (!Number.isInteger(options.width) || options.width < 1 || options.width > 1440 ||
      !Number.isInteger(options.height) || options.height < 1 || options.height > 900) {
    throw new Error("Screenshot width must be an integer between 1 and 1440 pixels and height " +
        "between 1 and 900 pixels to limit remote browser memory use.");
  }
}

/** Renders a Gadget's settled visible viewport as a bounded in-memory PNG. */
export async function renderGadgetScreenshot(
  browserBinding: BrowserRun,
  clientCode: string,
  gadget: Disposable,
  options: GadgetScreenshotOptions,
): Promise<Uint8Array> {
  try {
    validateScreenshotOptions(options);
  } catch (error) {
    gadget[Symbol.dispose]();
    throw error;
  }

  let {page, deadline, release} = await initializeExport(
      browserBinding, clientCode, gadget, options);
  try {
    let png = await deadline.race(page.screenshot({type: "png", fullPage: false}));
    if (png.byteLength > MAX_SCREENSHOT_BYTES) {
      throw new Error(`Screenshot PNG may not exceed ${MAX_SCREENSHOT_BYTES} bytes.`);
    }
    return new Uint8Array(png);
  } catch (error) {
    // Deliberately omits Gadget-authored exception text from logs.
    logger.warn("failed to render gadget export", { event: "gadget.export.render.failed" });
    throw error;
  } finally {
    await release();
  }
}
