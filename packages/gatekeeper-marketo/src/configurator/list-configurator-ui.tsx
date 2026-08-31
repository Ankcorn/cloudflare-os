import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  MarketoListConfiguratorRpc,
  MarketoListConfiguratorValues,
} from "./configurator-types";

export default {
  initial: { listId: null },

  isReady({ values }) {
    return Boolean(values.listId);
  },

  resourceUrl({ values, ui }) {
    return ui.resourceUrl(values.listId);
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field
        label="Static list"
        description="Scopes this connection to one Marketo static list: reading, adding, and removing its members."
      >
        <Autocomplete
          name="listId"
          value={values.listId}
          placeholder="Search static lists…"
          loadOptions={(query) => ui.listStaticLists(query)}
          onChange={(listId) => setValues({ listId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<MarketoListConfiguratorRpc, MarketoListConfiguratorValues>;
