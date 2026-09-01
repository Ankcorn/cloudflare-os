import { h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";

import type {
  MarketoDesignStudioConfiguratorRpc,
  MarketoDesignStudioConfiguratorValues,
} from "./configurator-types";

export default {
  initial: {},

  async initialValuesFromResourceUrl({ resourceUrl, ui }) {
    let requested = new URL(resourceUrl);
    let expected = new URL(await ui.resourceUrl());
    requested.pathname = requested.pathname.replace(/\/$/, "");
    expected.pathname = expected.pathname.replace(/\/$/, "");
    if (requested.href !== expected.href) {
      throw new Error("This resource belongs to a different Marketo instance. Select its account instead.");
    }
    return {};
  },

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
          landing pages, forms, classic snippets, and files; mutate their content and metadata;
          publish drafts, which can propagate changes into dependent assets; permanently discard
          drafts; and permanently delete assets and empty folders. Separately, this can create Email
          Designer fragments, update their metadata and content, publish changes that can propagate
          to dependent emails or templates, and permanently delete them. This does not grant access
          to people or campaign data.
        </p>
      </Section>
    );
  },
} satisfies ConfiguratorUISpec<
  MarketoDesignStudioConfiguratorRpc,
  MarketoDesignStudioConfiguratorValues
>;
