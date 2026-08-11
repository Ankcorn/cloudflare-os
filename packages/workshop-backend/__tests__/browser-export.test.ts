import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcStub, RpcTarget } from "capnweb";

const launch = vi.hoisted(() => vi.fn());
vi.mock("@cloudflare/puppeteer", () => ({ launch }));

const { BrowserRpcTransport, limitStream, screenCapture } =
    await import("../src/browser-export.js");

type Harness = {
  browserClosed: () => boolean;
  clientInitialized: () => boolean;
  fontsWaitedFor: () => boolean;
  gadgetDisposed: () => boolean;
  mediaTypes: () => string[];
  pdfRequested: () => boolean;
  renderSettled: () => boolean;
  screenshotQualities: () => number[];
  screenshotScales: () => number[];
  viewport: () => {
    width: number;
    height: number;
    deviceScaleFactor?: number;
    isMobile?: boolean;
    hasTouch?: boolean;
  } | undefined;
  viewportSetBeforeNavigation: () => boolean;
};

class TestGadget extends RpcTarget {
  constructor(private onDispose: () => void) {
    super();
  }

  [Symbol.dispose]() {
    this.onDispose();
  }
}

function makeHarness({
  pdfChunks = ["%PDF-1.4"],
  closePdf = true,
  screenshotSizes = [100],
}: {
  pdfChunks?: string[];
  closePdf?: boolean;
  screenshotSizes?: number[];
} = {}) {
  let browserClosed = false;
  let clientInitialized = false;
  let documentTitle: string | undefined;
  let fontsWaitedFor = false;
  let gadgetDisposed = false;
  let mediaTypes: string[] = [];
  let navigationStarted = false;
  let pdfRequested = false;
  let renderSettled = false;
  let screenshotQualities: number[] = [];
  let screenshotScales: number[] = [];
  let viewport: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
    isMobile?: boolean;
    hasTouch?: boolean;
  } | undefined;
  let viewportSetBeforeNavigation = false;

  let page = {
    setViewport: async (value: typeof viewport) => {
      viewport = value;
      viewportSetBeforeNavigation = !navigationStarted;
    },
    setRequestInterception: async () => {},
    on: () => {},
    goto: async () => { navigationStarted = true; },
    mainFrame: () => ({}),
    emulateMediaType: async (type: string) => { mediaTypes.push(type); },
    evaluate: (fn: (...args: never[]) => unknown, ...args: unknown[]) => {
      if (fn.toString().includes("__workshopExportModulePromise")) {
        clientInitialized = true;
        renderSettled = fn.toString().includes("MutationObserver");
        fontsWaitedFor = args[1] === true;
        return Promise.resolve();
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
      expect(documentTitle).toBe("Test Gadget");
      pdfRequested = true;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (let chunk of pdfChunks) controller.enqueue(new TextEncoder().encode(chunk));
          if (closePdf) controller.close();
        },
      });
    },
    screenshot: async ({quality, clip}: {quality: number; clip?: {scale?: number}}) => {
      expect(clientInitialized).toBe(true);
      expect(renderSettled).toBe(true);
      screenshotQualities.push(quality);
      screenshotScales.push(clip?.scale ?? 1);
      let size = screenshotSizes[Math.min(screenshotQualities.length - 1,
          screenshotSizes.length - 1)];
      return new Uint8Array(size);
    },
  };

  launch.mockResolvedValue({
    newPage: async () => page,
    close: async () => {
      browserClosed = true;
    },
  });

  let gadget = new RpcStub(new TestGadget(() => { gadgetDisposed = true; }));

  let harness: Harness = {
    browserClosed: () => browserClosed,
    clientInitialized: () => clientInitialized,
    fontsWaitedFor: () => fontsWaitedFor,
    gadgetDisposed: () => gadgetDisposed,
    mediaTypes: () => mediaTypes,
    pdfRequested: () => pdfRequested,
    renderSettled: () => renderSettled,
    screenshotQualities: () => screenshotQualities,
    screenshotScales: () => screenshotScales,
    viewport: () => viewport,
    viewportSetBeforeNavigation: () => viewportSetBeforeNavigation,
  };
  return { gadget, harness };
}

function render(pdfChunks?: string[], closePdf = true) {
  let { gadget, harness } = makeHarness({pdfChunks, closePdf});
  let result = screenCapture(
    {} as BrowserRun,
    "export default {}",
    gadget as never,
    {format: "pdf", documentTitle: "Test Gadget"},
  );
  return { result, harness };
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

describe("screenCapture", () => {
  it("settles the client render, streams a PDF, and releases the browser", async () => {
    let { result, harness } = render();
    let capture = await result;

    expect(await collect(capture)).toBe("%PDF-1.4");
    expect(harness.clientInitialized()).toBe(true);
    expect(harness.renderSettled()).toBe(true);
    expect(harness.fontsWaitedFor()).toBe(false);
    expect(harness.mediaTypes()).toEqual(["print"]);
    expect(harness.pdfRequested()).toBe(true);
    expect(harness.browserClosed()).toBe(true);
    expect(harness.gadgetDisposed()).toBe(true);
  });

  it("releases the browser when the consumer cancels the stream", async () => {
    let { result, harness } = render(["first", "second"]);

    let reader = (await result).getReader();
    await reader.read();
    await reader.cancel("no longer needed");

    expect(harness.browserClosed()).toBe(true);
  });

  it("releases the browser when the export stream exceeds its deadline", async () => {
    vi.useFakeTimers();
    try {
      let { result, harness } = render(["first"], false);
      let reader = (await result).getReader();
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
      let result = screenCapture(
        {} as BrowserRun,
        "export default {}",
        { [Symbol.dispose]: () => { gadgetDisposed = true; } } as never,
        {format: "pdf", documentTitle: "Test Gadget"},
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

    await expect(screenCapture(
      {} as BrowserRun,
      "export default {}",
      { [Symbol.dispose]: () => { gadgetDisposed = true; } } as never,
      {format: "pdf", documentTitle: "Test Gadget"},
    )).rejects.toThrow("no browser available");
    expect(gadgetDisposed).toBe(true);
  });

  it("captures a bounded JPEG at the fixed viewport and releases before returning", async () => {
    let {gadget, harness} = makeHarness({screenshotSizes: [123]});

    let capture = await screenCapture(
      {} as BrowserRun,
      "export default {}",
      gadget as never,
      {format: "jpeg"},
    );

    expect(capture).toBeInstanceOf(Uint8Array);
    expect(capture.byteLength).toBe(123);
    expect(harness.viewport()).toEqual({width: 1280, height: 720, deviceScaleFactor: 1});
    expect(harness.viewportSetBeforeNavigation()).toBe(true);
    expect(harness.fontsWaitedFor()).toBe(true);
    expect(harness.mediaTypes()).toEqual([]);
    expect(harness.screenshotQualities()).toEqual([80]);
    expect(harness.screenshotScales()).toEqual([1]);
    expect(harness.browserClosed()).toBe(true);
    expect(harness.gadgetDisposed()).toBe(true);
  });

  it("retries JPEG encoding on the same page when the first capture exceeds the limit", async () => {
    let {gadget, harness} = makeHarness({
      screenshotSizes: [1024 * 1024 + 1, 1024],
    });

    let capture = await screenCapture(
      {} as BrowserRun,
      "export default {}",
      gadget as never,
      {format: "jpeg"},
    );

    expect(capture.byteLength).toBe(1024);
    expect(harness.screenshotQualities()).toEqual([80, 50]);
    expect(harness.screenshotScales()).toEqual([1, 1]);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(harness.browserClosed()).toBe(true);
    expect(harness.gadgetDisposed()).toBe(true);
  });

  it("renders the mobile preset before navigation", async () => {
    let {gadget, harness} = makeHarness();

    await screenCapture(
      {} as BrowserRun,
      "export default {}",
      gadget as never,
      {format: "jpeg", viewport: "mobile"},
    );

    expect(harness.viewport()).toEqual({
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
    });
    expect(harness.viewportSetBeforeNavigation()).toBe(true);
  });

  it("progressively downscales the same viewport until the JPEG fits", async () => {
    let oversized = 1024 * 1024 + 1;
    let {gadget, harness} = makeHarness({
      screenshotSizes: [oversized, oversized, oversized, 1024],
    });

    let capture = await screenCapture(
      {} as BrowserRun,
      "export default {}",
      gadget as never,
      {format: "jpeg"},
    );

    expect(capture.byteLength).toBe(1024);
    expect(harness.screenshotQualities()).toEqual([80, 50, 40, 35]);
    expect(harness.screenshotScales()).toEqual([1, 1, 0.75, 0.5]);
    expect(harness.browserClosed()).toBe(true);
    expect(harness.gadgetDisposed()).toBe(true);
  });

  it("rejects rather than returning an oversized JPEG if every fallback exceeds the cap", async () => {
    let {gadget, harness} = makeHarness({
      screenshotSizes: [1024 * 1024 + 1],
    });

    await expect(screenCapture(
      {} as BrowserRun,
      "export default {}",
      gadget as never,
      {format: "jpeg"},
    )).rejects.toThrow("Gadget screenshots may not exceed 1048576 bytes.");
    expect(harness.screenshotQualities()).toEqual([80, 50, 40, 35, 30, 20]);
    expect(harness.screenshotScales()).toEqual([1, 1, 0.75, 0.5, 0.25, 0.1]);
    expect(harness.browserClosed()).toBe(true);
    expect(harness.gadgetDisposed()).toBe(true);
  });
});
