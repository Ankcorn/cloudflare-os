import { h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  MarketoInstanceConfiguratorRpc,
  MarketoInstanceConfiguratorValues,
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
    return <Section>
      <p>Grants access to every person, list, program, campaign, and custom object available to this Marketo connection.</p>
    </Section>;
  },
} satisfies ConfiguratorUISpec<MarketoInstanceConfiguratorRpc, MarketoInstanceConfiguratorValues>;
