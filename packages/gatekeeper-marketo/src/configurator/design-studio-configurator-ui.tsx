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
          Grants access to Design Studio folders, emails, templates, landing pages, forms, snippets,
          and files, without granting access to people or campaign data.
        </p>
      </Section>
    );
  },
} satisfies ConfiguratorUISpec<
  MarketoDesignStudioConfiguratorRpc,
  MarketoDesignStudioConfiguratorValues
>;
