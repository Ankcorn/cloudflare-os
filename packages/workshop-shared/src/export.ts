import type { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

// Gadget-facing export API:

/** Name under which a Gadget may export its optional export handler entrypoint. */
export const GADGET_EXPORT_ENTRYPOINT = "ExportHandler";

/**
 * Describes an export target that a Gadget supports. Export targets are split
 * into two modes:
 *
 * Browser mode: The Gadget UI is loaded in a remote browser and the rendered
 * output is captured, either by printing the page to PDF or returning the
 * underlying HTML. Browser mode exports are limited to a small set of file
 * formats that can be easily captured using the Browser Run binding.
 *
 * Custom mode: The server-side export handler entrypoint returns the file
 * content directly. Export targets are unrestricted, and a Gadget may (on rare
 * occasion) reimplement a browser-mode export target server-side if it wants
 * total control over the exported file content.
*/
export type GadgetExportTarget =
  | {
    /**
     * Unique, non-empty identifier for this target. A Gadget can support
     * multiple HTML variants with different ids. The Workshop injects the
     * global variable `gadgetExportTargetId` before the Gadget UI module
     * evaluates; it identifies the selected variant during browser rendering.
     */
    id: string;

    /** User-facing label, usually "HTML" unless multiple variants are supported. */
    label: string;

    /** Selects browser-based rendering. */
    mode: "browser";

    /** Media type produced by this browser-based target. */
    contentType: "text/html";
  }
  | {
    /**
     * Unique, non-empty identifier for this target. A Gadget can support
     * multiple PDF variants with different ids. The Workshop injects the global
     * variable `gadgetExportTargetId` before the Gadget UI module evaluates; it
     * identifies the selected variant during browser rendering.
     */
    id: string;

    /** User-facing label, usually "PDF" unless multiple variants are supported. */
    label: string;

    /** Selects browser-based rendering. */
    mode: "browser";

    /** Media type produced by this browser-based target. */
    contentType: "application/pdf";
  }
  | {
    /** Unique, non-empty identifier for this target. */
    id: string;

    /** User-facing label for the export target. */
    label: string;

    /** Selects server-side generation by the Gadget's export handler. */
    mode: "custom";

    /** Media type produced by this custom target. */
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
   * Lists the export targets supported by this Gadget. When this entrypoint is
   * absent, the Workshop defaults to:
   *  - { id: "html", label: "HTML", mode: "browser", contentType: "text/html"}
   *  - { id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf"}
   * Every `ExportHandler` entrypoint must implement this method. The Workshop rejects
   * a missing `getExportFormats` method instead of applying defaults. Returning an
   * empty list disables file exports.
   *
   * When implementing this method, the Gadget should return these browser-mode
   * export targets in addition to any custom targets, unless it specifically
   * does not want to support browser-mode HTML or PDF exports.
   */
  getExportTargets(gadget: Fetcher<Gadget>): Promise<GadgetExportTarget[]>;

  /**
   * Produces the custom target identified by an id returned from
   * `getExportTargets()`. Only called for custom-mode export targets.
   * Browser-mode export targets are handled by the Workshop backend.
   *
   * The Workshop enforces 30s export duration and 100MB file size limits while
   * consuming the returned stream. It derives the filename from the Gadget
   * title and the target's `fileExtension`; the handler does not control the
   * base filename.
   */
  export(gadget: Fetcher<Gadget>, id: string): Promise<ReadableStream<Uint8Array>>;
}

// Export API exposed to the Workshop UI:

/**
 * Describes an export target that a Gadget supports. Hides browser- vs.
 * custom-mode and default target implementation details.
 */
export type GadgetClientExportTarget = {
  /** Identifier to pass to `GadgetClientExportMethods.export()`. */
  id: string;

  /** Media type of the exported file. */
  contentType: string;

  /** User-facing name for the target. */
  label: string;

  /**
   * File extension, including the leading dot. Inferred by the Workshop for
   * browser-mode exports.
   */
  fileExtension: string;
};

/**
 * Export methods that will be added directly to `GadgetClient`, rather than
 * exposed as a separate RPC capability. These methods replace the existing
 * `GadgetClient.exportPdf()` method when implemented.
 */
export interface GadgetClientExportMethods {
  /**
   * Lists supported export targets, including default targets if the Gadget
   * does not implement ExportHandler.
   */
  getExportTargets(chatId?: number): Promise<GadgetClientExportTarget[]>;

  /** Exports the target with the given ID. */
  export(id: string, chatId?: number): Promise<ReadableStream<Uint8Array>>;
}
