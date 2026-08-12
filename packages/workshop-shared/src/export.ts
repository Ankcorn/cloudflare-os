import type { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

// Gadget-facing export API:

/** Name under which a Gadget may export its optional export handler entrypoint. */
export const GADGET_EXPORT_ENTRYPOINT = "ExportHandler";

declare global {
  /**
   * Identifies the selected browser-mode export format. This is undefined when
   * the Gadget UI is rendered interactively.
   */
  var gadgetExportFormatId: string | undefined;
}

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

/** Serializable capability exposing a Gadget Durable Object's public RPC methods. */
export type GadgetExportCapability<Gadget extends DurableObject = DurableObject> =
  RpcStub<RpcTarget & Pick<Gadget, keyof Gadget>>;

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
  getExportFormats(gadget: GadgetExportCapability<Gadget>): Promise<GadgetExportFormat[]>;

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
  export(gadget: GadgetExportCapability<Gadget>, id: string): Promise<ReadableStream<Uint8Array>>;
}
