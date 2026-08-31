import { h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";

import type {
  MarketoDesignStudioConfiguratorRpc,
  MarketoDesignStudioConfiguratorValues,
} from "./configurator-types";

export default {
  initial: {},

  isReady() {
    return true;
  },

  resourceUrl({ ui }) {
    return ui.resourceUrl();
  },

  render() {
    return (
      <Section>
        <p>
          Grants authority to read and create or clone Design Studio folders, emails, templates,
          landing pages, forms, snippets, and files; mutate their content and metadata; publish
          drafts, which can propagate changes into dependent assets; permanently discard drafts;
          and permanently delete assets and empty folders. This does not grant access to people or
          campaign data.
        </p>
      </Section>
    );
  },
} satisfies ConfiguratorUISpec<
  MarketoDesignStudioConfiguratorRpc,
  MarketoDesignStudioConfiguratorValues
>;
