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
      <p>Grants access to every person, list, program, campaign, standard and custom business object, and Design Studio asset available to this Marketo connection, including write and deletion authority where the connected role permits it.</p>
    </Section>;
  },
} satisfies ConfiguratorUISpec<MarketoInstanceConfiguratorRpc, MarketoInstanceConfiguratorValues>;
