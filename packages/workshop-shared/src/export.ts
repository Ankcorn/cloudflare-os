import type { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

// Gadget-facing export API:

/** Name under which a Gadget may export its optional export handler entrypoint. */
export const GADGET_EXPORT_ENTRYPOINT = "ExportHandler";

/**
 * Describes an export format that a Gadget supports. Export formats are split
 * into two modes:
 *
 * Browser mode: The Gadget UI is loaded in a remote browser and the rendered
 * output is captured as HTML, PDF, PNG, or JPEG using the Browser Run binding.
 *
 * Server mode: The server-side export handler entrypoint returns the file
 * content directly. File formats are unrestricted, and a Gadget may reimplement
 * a browser-mode format server-side if it wants total control over the exported
 * file content.
*/
export type GadgetExportFormat = {
  /**
   * Unique, non-empty identifier for this format. During browser rendering, the
   * Workshop injects this value as `gadgetExportFormatId` before the Gadget UI
   * module evaluates, allowing multiple variants of the same media type.
   */
  id: string;

  /** User-facing label for the format. */
  label: string;

  /** Whether the Workshop captures a browser or invokes the server-side handler. */
  mode: "browser" | "server";

  /**
   * Media type of the exported file. Browser mode supports `text/html`,
   * `application/pdf`, `image/png`, and `image/jpeg`; server mode is unrestricted.
   */
  contentType: string;

  /** File extension, including the leading dot. */
  fileExtension: string;
};

/**
 * Optional Worker entrypoint exported by a Gadget as `ExportHandler` to
 * customize file export behavior.
 *
 * @typeParam Gadget The Gadget Durable Object type accepted by the handler.
 */
export interface GadgetExportEntrypoint<Gadget extends DurableObject = DurableObject>
    extends WorkerEntrypoint {
  /**
   * Lists the export formats supported by this Gadget. When this entrypoint is
   * absent, the Workshop defaults to:
   *  - { id: "html", label: "HTML", mode: "browser", contentType: "text/html",
   *      fileExtension: ".html" }
   *  - { id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf",
   *      fileExtension: ".pdf" }
   *
   * Every `ExportHandler` entrypoint must implement this method. The Workshop
   * rejects a missing `getExportFormats` method instead of applying defaults.
   * Returning an empty list disables file exports.
   *
   * When implementing this method, the Gadget should return these browser-mode
   * export formats in addition to any server-mode formats, unless it specifically
   * does not want to support browser-mode HTML or PDF exports.
   */
  getExportFormats(gadget: Fetcher<Gadget>): Promise<GadgetExportFormat[]>;

  /**
   * Produces the server-side format identified by an id returned from
   * `getExportFormats()`. Only called for server-mode export formats.
   * Browser-mode export formats are handled by the Workshop backend.
   *
   * The Workshop enforces 30s export duration and 100MB file size limits while
   * consuming the returned stream. It derives the filename from the Gadget
   * title and the format's `fileExtension`; the handler does not control the
   * base filename.
   */
  export(gadget: Fetcher<Gadget>, id: string): Promise<ReadableStream<Uint8Array>>;
}

// Export API exposed to the Workshop UI:

/**
 * Export methods that will be added directly to `GadgetClient`, rather than
 * exposed as a separate RPC capability. These methods replace the existing
 * `GadgetClient.exportPdf()` method when implemented.
 */
export interface GadgetClientExportMethods {
  /**
   * Lists supported export formats, including default formats if the Gadget
   * does not implement ExportHandler.
   */
  getExportFormats(chatId?: number): Promise<GadgetExportFormat[]>;

  /** Exports the format with the given ID. */
  export(id: string, chatId?: number): Promise<ReadableStream<Uint8Array>>;
}
