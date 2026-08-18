import { beforeEach, describe, expect, it, vi } from "vitest";

const launch = vi.hoisted(() => vi.fn());
vi.mock("@cloudflare/puppeteer", () => ({ launch }));
vi.mock("capnweb", () => ({
  RpcSession: class {
    constructor(_transport: object, private localMain: Disposable) {}

    getRemoteMain() {
      return {
        [Symbol.dispose]: () => this.localMain[Symbol.dispose](),
      };
    }
  },
}));

const { BrowserRpcTransport, limitStream, renderGadgetPdf, renderGadgetScreenshot } =
    await import("../src/browser-export.js");

type Harness = {
  browserClosed: () => boolean;
  clientInitialized: () => boolean;
  gadgetDisposed: () => boolean;
  pdfRequested: () => boolean;
  renderSettled: () => boolean;
  resourcesSettled: () => boolean;
  resourcesWaitStarted: () => boolean;
  settleFonts: () => void;
  settleImages: () => void;
  screenshotRequested: () => boolean;
  viewport: () => { width: number; height: number; deviceScaleFactor: number } | undefined;
  viewportAppliedBeforeNavigation: () => boolean;
};

function makeHarness(
  pdfChunks = ["%PDF-1.4"],
  closePdf = true,
  screenshotBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  screenshotError?: Error,
  launchError?: Error,
  resourcesPending = false,
) {
  let browserClosed = false;
  let clientInitialized = false;
  let documentTitle: string | undefined;
  let gadgetDisposed = false;
  let pdfRequested = false;
  let renderSettled = false;
  let fontsReady = Promise.withResolvers<void>();
  let imagesReady = Promise.withResolvers<void>();
  let resourcesSettled = false;
  let resourcesWaitStarted = false;
  let screenshotRequested = false;
  let viewport: { width: number; height: number; deviceScaleFactor: number } | undefined;
  let viewportAppliedBeforeNavigation = false;
  if (!resourcesPending) {
    fontsReady.resolve();
    imagesReady.resolve();
  }

  let page = {
    setRequestInterception: async () => {},
    setViewport: async (value: { width: number; height: number; deviceScaleFactor: number }) => {
      viewport = value;
    },
    on: () => {},
    goto: async () => { viewportAppliedBeforeNavigation = viewport !== undefined; },
    mainFrame: () => ({}),
    emulateMediaType: async () => {},
    evaluate: (fn: (...args: never[]) => unknown, ...args: unknown[]) => {
      if (fn.toString().includes("__workshopExportModulePromise")) {
        clientInitialized = true;
        renderSettled = fn.toString().includes("MutationObserver");
        return Promise.resolve();
      }
      if (fn.toString().includes("document.fonts")) {
        resourcesWaitStarted = true;
        return Promise.all([fontsReady.promise, imagesReady.promise])
            .then(() => { resourcesSettled = true; });
      }
      if (fn.toString().includes("document.title")) {
        documentTitle = typeof args[0] === "string" ? args[0] : undefined;
        return Promise.resolve();
      }
      // The RPC transport polls this; the fake page never has a message to deliver.
      return new Promise(() => {});
    },
    createPDFStream: async () => {
      expect(clientInitialized).toBe(true);
      expect(renderSettled).toBe(true);
      expect(resourcesSettled).toBe(true);
      expect(documentTitle).toBe("Test Gadget");
      pdfRequested = true;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (let chunk of pdfChunks) controller.enqueue(new TextEncoder().encode(chunk));
          if (closePdf) controller.close();
        },
      });
    },
    screenshot: async (options: { type: string; fullPage: boolean }) => {
      expect(clientInitialized).toBe(true);
      expect(renderSettled).toBe(true);
      expect(resourcesSettled).toBe(true);
      expect(options).toEqual({ type: "png", fullPage: false });
      screenshotRequested = true;
      if (screenshotError) throw screenshotError;
      return screenshotBytes;
    },
  };

  if (launchError) {
    launch.mockRejectedValue(launchError);
  } else {
    launch.mockResolvedValue({
      newPage: async () => page,
      close: async () => {
        browserClosed = true;
      },
    });
  }

  let gadget = {
    [Symbol.dispose]: () => {
      gadgetDisposed = true;
    },
  };

  let harness: Harness = {
    browserClosed: () => browserClosed,
    clientInitialized: () => clientInitialized,
    gadgetDisposed: () => gadgetDisposed,
    pdfRequested: () => pdfRequested,
    renderSettled: () => renderSettled,
    resourcesSettled: () => resourcesSettled,
    resourcesWaitStarted: () => resourcesWaitStarted,
    settleFonts: () => fontsReady.resolve(),
    settleImages: () => imagesReady.resolve(),
    screenshotRequested: () => screenshotRequested,
    viewport: () => viewport,
    viewportAppliedBeforeNavigation: () => viewportAppliedBeforeNavigation,
  };
  return { gadget, harness };
}

type PdfRenderRequest = {
  type: "pdf";
  pdfChunks?: string[];
  closePdf?: boolean;
  resourcesPending?: boolean;
};

type ScreenshotRenderRequest = {
  type: "screenshot";
  width: number;
  height: number;
  screenshotBytes?: Uint8Array;
  screenshotError?: Error;
  launchError?: Error;
  resourcesPending?: boolean;
};

function startRender(request: PdfRenderRequest)
    : { result: Promise<ReadableStream<Uint8Array>>; harness: Harness };
function startRender(request: ScreenshotRenderRequest)
    : { result: Promise<Uint8Array>; harness: Harness };
function startRender(request: PdfRenderRequest | ScreenshotRenderRequest) {
  let { gadget, harness } = makeHarness(
    request.type === "pdf" ? request.pdfChunks : undefined,
    request.type === "pdf" ? request.closePdf : undefined,
    request.type === "screenshot" ? request.screenshotBytes : undefined,
    request.type === "screenshot" ? request.screenshotError : undefined,
    request.type === "screenshot" ? request.launchError : undefined,
    request.resourcesPending,
  );
  let browserBinding = {} as BrowserRun;
  let gadgetStub = gadget as never;
  if (request.type === "pdf") {
    return {
      result: renderGadgetPdf(browserBinding, "export default {}", "Test Gadget", gadgetStub),
      harness,
    };
  }
  return {
    result: renderGadgetScreenshot(
      browserBinding,
      "export default {}",
      gadgetStub,
      { width: request.width, height: request.height },
    ),
    harness,
  };
}

function render(pdfChunks?: string[], closePdf = true) {
  let { result: stream, harness } = startRender({type: "pdf", pdfChunks, closePdf});
  return { stream, harness };
}

function renderScreenshot(
  width: number,
  height: number,
  screenshotBytes?: Uint8Array,
  screenshotError?: Error,
) {
  let { result: screenshot, harness } = startRender({
    type: "screenshot",
    width,
    height,
    screenshotBytes,
    screenshotError,
  });
  return { screenshot, harness };
}

function renderScreenshotWithLaunchFailure() {
  let { result: screenshot, harness } = startRender({
    type: "screenshot",
    width: 390,
    height: 844,
    launchError: new Error("no browser available"),
  });
  return { screenshot, harness };
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  let reader = stream.getReader();
  let text = "";
  let decoder = new TextDecoder();
  for (;;) {
    let { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

beforeEach(() => {
  launch.mockReset();
});

describe("BrowserRpcTransport", () => {
  it("aborts all queued sends when stalled browser delivery exceeds the count limit", async () => {
    let transport = new BrowserRpcTransport({
      evaluate: () => new Promise(() => {}),
    } as never);
    let pending = Array.from({ length: 1024 }, () => transport.send("message"));
    let pendingResults = Promise.allSettled(pending);

    await expect(transport.send("overflow")).rejects.toThrow("send queue overflowed");
    expect((await pendingResults).every(result => result.status === "rejected")).toBe(true);
  });
});

describe("limitStream", () => {
  it("passes through output that stays within the cap", async () => {
    expect(await collect(limitStream(streamOf(["abc", "de"]), 5))).toBe("abcde");
  });

  it("fails as soon as the cap is exceeded rather than buffering the whole export", async () => {
    let reader = limitStream(streamOf(["abcd", "efgh"]), 6).getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await expect(reader.read()).rejects.toThrow("may not exceed 6 bytes");
  });
});

describe("renderGadgetPdf", () => {
  it("waits for fonts and images before capturing and still releases resources", async () => {
    let { result: stream, harness } = startRender({type: "pdf", resourcesPending: true});
    await vi.waitFor(() => expect(harness.resourcesWaitStarted()).toBe(true));

    expect(harness.pdfRequested()).toBe(false);
    harness.settleFonts();
    await Promise.resolve();
    expect(harness.pdfRequested()).toBe(false);
    harness.settleImages();

    expect(await collect(await stream)).toBe("%PDF-1.4");
    expect(harness.resourcesSettled()).toBe(true);
    expect(harness.browserClosed()).toBe(true);
    expect(harness.gadgetDisposed()).toBe(true);
  });

  it("settles the client render, streams a PDF, and releases the browser", async () => {
    let { stream, harness } = render();

    expect(await collect(await stream)).toBe("%PDF-1.4");
    expect(harness.clientInitialized()).toBe(true);
    expect(harness.renderSettled()).toBe(true);
    expect(harness.pdfRequested()).toBe(true);
    expect(harness.browserClosed()).toBe(true);
  });

  it("releases the browser when the consumer cancels the stream", async () => {
    let { stream, harness } = render(["first", "second"]);

    let reader = (await stream).getReader();
    await reader.read();
    await reader.cancel("no longer needed");

    expect(harness.browserClosed()).toBe(true);
  });

  it("releases the browser when the export stream exceeds its deadline", async () => {
    vi.useFakeTimers();
    try {
      let { stream, harness } = render(["first"], false);
      let reader = (await stream).getReader();
      await expect(reader.read()).resolves.toMatchObject({ done: false });

      await vi.advanceTimersByTimeAsync(30_000);

      expect(harness.browserClosed()).toBe(true);
      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it("disposes the Gadget and closes a browser that launches after the deadline", async () => {
    vi.useFakeTimers();
    try {
      let pendingLaunch = Promise.withResolvers<{ close(): Promise<void> }>();
      let browserClosed = false;
      let gadgetDisposed = false;
      launch.mockReturnValue(pendingLaunch.promise);
      let result = renderGadgetPdf(
        {} as BrowserRun,
        "export default {}",
        "Test Gadget",
        { [Symbol.dispose]: () => { gadgetDisposed = true; } } as never,
      );
      let rejection = expect(result).rejects.toThrow("Browser export timed out.");

      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
      expect(gadgetDisposed).toBe(true);

      pendingLaunch.resolve({
        close: async () => { browserClosed = true; },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(browserClosed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the browser and disposes the Gadget when launching fails", async () => {
    let gadgetDisposed = false;
    launch.mockRejectedValue(new Error("no browser available"));

    await expect(renderGadgetPdf(
      {} as BrowserRun,
      "export default {}",
      "Test Gadget",
      { [Symbol.dispose]: () => { gadgetDisposed = true; } } as never,
    )).rejects.toThrow("no browser available");
    expect(gadgetDisposed).toBe(true);
  });
});

describe("renderGadgetScreenshot", () => {
  it("waits for fonts and images before capturing and still releases resources", async () => {
    let { result: screenshot, harness } = startRender({
      type: "screenshot",
      width: 390,
      height: 844,
      resourcesPending: true,
    });
    await vi.waitFor(() => expect(harness.resourcesWaitStarted()).toBe(true));

    expect(harness.screenshotRequested()).toBe(false);
    harness.settleImages();
    await Promise.resolve();
    expect(harness.screenshotRequested()).toBe(false);
    harness.settleFonts();

    await screenshot;
    expect(harness.resourcesSettled()).toBe(true);
    expect(harness.browserClosed()).toBe(true);
    expect(harness.gadgetDisposed()).toBe(true);
  });

  it("applies the viewport before navigation, settles the DOM, and returns PNG bytes", async () => {
    let png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    let { screenshot, harness } = renderScreenshot(390, 844, png);

    expect(await screenshot).toEqual(png);
    expect(harness.viewport()).toEqual({ width: 390, height: 844, deviceScaleFactor: 1 });
    expect(harness.viewportAppliedBeforeNavigation()).toBe(true);
    expect(harness.renderSettled()).toBe(true);
    expect(harness.screenshotRequested()).toBe(true);
  });

  it.each([
    [0, 844],
    [390, 0],
    [1441, 900],
    [1440, 901],
    [390.5, 844],
  ])("rejects dimensions outside the bounded browser viewport (%s x %s)", async (width, height) => {
    let { screenshot, harness } = renderScreenshot(width, height);

    await expect(screenshot).rejects.toThrow("between 1 and");
    expect(launch).not.toHaveBeenCalled();
    expect(harness.gadgetDisposed()).toBe(true);
  });

  it("rejects a PNG that exceeds the screenshot byte cap", async () => {
    let { screenshot, harness } = renderScreenshot(
      1440,
      900,
      new Uint8Array(5 * 1024 * 1024 + 1),
    );

    await expect(screenshot).rejects.toThrow("Screenshot PNG may not exceed");
    expect(harness.browserClosed()).toBe(true);
    expect(harness.gadgetDisposed()).toBe(true);
  });

  it("releases the browser and Gadget when rendering fails", async () => {
    let { screenshot, harness } = renderScreenshot(
      390,
      844,
      undefined,
      new Error("screenshot failed"),
    );

    await expect(screenshot).rejects.toThrow("screenshot failed");
    expect(harness.browserClosed()).toBe(true);
    expect(harness.gadgetDisposed()).toBe(true);
  });

  it("releases the Gadget when launching fails", async () => {
    let { screenshot, harness } = renderScreenshotWithLaunchFailure();

    await expect(screenshot).rejects.toThrow("no browser available");
    expect(harness.gadgetDisposed()).toBe(true);
  });

  it("closes the browser and disposes the Gadget before returning success", async () => {
    let { screenshot, harness } = renderScreenshot(1440, 900);

    await screenshot;
    expect(harness.browserClosed()).toBe(true);
    expect(harness.gadgetDisposed()).toBe(true);
  });
});
