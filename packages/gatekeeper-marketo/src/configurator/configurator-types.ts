// Types shared between the sandboxed configurator UIs and the gatekeeper capabilities that back
// them. These UIs are untrusted, so each capability below is deliberately read-only and narrow.

import type { ConfiguratorUIOption, ConfiguratorUIValues } from "@gadgets/configurator-ui";

/** One selectable option shown in a configurator picker. */
export type MarketoConfiguratorOption = ConfiguratorUIOption;

/** Capability backing the whole-instance configurator. */
export type MarketoInstanceConfiguratorRpc = {
  /** Resource URL for whole-instance access. */
  resourceUrl(): Promise<string>;
};

/** Form values for the whole-instance configurator (it has no inputs). */
export type MarketoInstanceConfiguratorValues = ConfiguratorUIValues;

/** Capability backing the program picker. */
export type MarketoProgramConfiguratorRpc = {
  /** Find selectable programs by id or name. */
  listPrograms(query: string): Promise<MarketoConfiguratorOption[]>;
  /** Build the concrete resource URL for the selected program. */
  resourceUrl(programId: string | null | undefined): Promise<string>;
};

/** Form values for the program picker. `programId` matches the `:programId` pattern group, so
 * pre-filling from a concrete resource URL works without extra mapping. */
export type MarketoProgramConfiguratorValues = ConfiguratorUIValues & {
  /** Selected program id, or null before a selection is made. */
  programId?: string | null;
};

/** Capability backing the static-list picker. */
export type MarketoListConfiguratorRpc = {
  /** Find selectable static lists by id or name. */
  listStaticLists(query: string): Promise<MarketoConfiguratorOption[]>;
  /** Build the concrete resource URL for the selected static list. */
  resourceUrl(listId: string | null | undefined): Promise<string>;
};

/** Form values for the static-list picker. `listId` matches the `:listId` pattern group. */
export type MarketoListConfiguratorValues = ConfiguratorUIValues & {
  /** Selected static-list id, or null before a selection is made. */
  listId?: string | null;
};

/** Capability backing the input-free Design Studio configurator. */
export type MarketoDesignStudioConfiguratorRpc = {
  /** Resource URL for broad Design Studio access. */
  resourceUrl(): Promise<string>;
};

/** Form values for the Design Studio configurator, which has no inputs. */
export type MarketoDesignStudioConfiguratorValues = ConfiguratorUIValues;
