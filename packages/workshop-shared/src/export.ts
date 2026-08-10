import type { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

// Gadget-facing export API:

/** Name under which a Gadget may export its optional export handler entrypoint. */
export const GADGET_EXPORT_ENTRYPOINT = "ExportHandler";

/**
 * Describes an export format that a Gadget supports. Export formats are split
 * into two modes:
 *
 * Browser mode: The Gadget UI is loaded in a remote browser and the rendered
 * output is captured, either by printing the page to PDF or returning the
 * underlying HTML. Browser mode exports are limited to a small set of formats
 * that can be easily captured using the Browser Run binding.
 *
 * Custom mode: The server-side export handler entrypoint returns the file
 * content directly. Export formats are unrestricted, and a Gadget may (on rare
 * occasion) reimplement a browser-mode export format server-side if it wants
 * total control over the exported file content.
*/
export type GadgetExportFormat =
  | {
    // A Gadget can support multiple HTML or PDF export variants by returning
    // multiple browser-mode export entries with different ids. When the Gadget
    // UI is loaded in a remote browser, globalThis.gadgetExportFormatId will be
    // set to the selected format id so the Gadget UI knows which variant to
    // render.
    id: string;
    // User-facing label for the export format. Usually "HTML" unless multiple
    // HTML variants are supported
    label: string;
    mode: "browser";
    contentType: "text/html";
  }
  | {
    id: string;
    // User-facing label for the export format. Usually "PDF" unless multiple
    // PDF variants are supported
    label: string;
    mode: "browser";
    contentType: "application/pdf";
  }
  | {
    id: string;
    label: string;
    mode: "custom";
    contentType: string;
    fileExtension: string;
  };

/**
 * Optional Worker entrypoint exported by a Gadget as `ExportHandler` to
 * customize file export behavior.
 */
export interface GadgetExportEntrypoint<Gadget extends DurableObject = DurableObject>
    extends WorkerEntrypoint {
  /**
   * Lists the export formats supported by this Gadget. When this entrypoint or
   * method is absent, the Workshop defaults to:
   *  - { id: "html", label: "HTML", mode: "browser", contentType: "text/html"}
   *  - { id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf"}
   *
   * When implementing this method, the Gadget should return these browser-mode
   * export formats in addition to any custom formats, unless it specifically
   * does not want to support browser-mode HTML or PDF exports. Export format
   * ids must be unique across both modes.
   */
  getExportFormats(gadget: Fetcher<Gadget>): Promise<GadgetExportFormat[]>;

  /**
   * Produces the custom format identified by an id returned from
   * `getExportFormats()`. Only called for custom-mode export formats.
   * Browser-mode export formats are handled by the workshop backend.
   */
  export(gadget: Fetcher<Gadget>, id: string): Promise<ReadableStream<Uint8Array>>;
}

// Export API exposed to the workshop UI:

/**
 * Describes an export format that a Gadget supports. Hides browser- vs.
 * custom-mode and default format implementation details.
 */
export type GadgetClientExportFormat = {
  /** Identifier to pass to `GadgetClientExportApi.export()`. */
  id: string;

  /** Media type of the exported file. */
  contentType: string;

  /** User-facing name for the format. */
  label: string;

  /**
   * File extension, including the leading dot. Inferred by workshop for
   * browser-mode exports.
   */
  fileExtension: string;
};


/**
 * Gadget export API used by the workshop UI, and potentially the workshop agent
 * in the future.
 */
export interface GadgetClientExportApi {
  /**
   * Lists supported export formats, including default formats if the Gadget
   * does not implement ExportHandler.
   */
  getExportFormats(chatId?: number): Promise<GadgetClientExportFormat[]>;

  /** Exports the format with the given ID. */
  export(id: string, chatId?: number): Promise<ReadableStream<Uint8Array>>;
}
