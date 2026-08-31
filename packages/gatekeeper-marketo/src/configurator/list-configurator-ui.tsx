import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  MarketoListConfiguratorRpc,
  MarketoListConfiguratorValues,
} from "./configurator-types";

export default {
  initial: { listId: null },

  async initialValuesFromResourceUrl({ resourceUrl, ui }) {
    let listId = new URL(resourceUrl).pathname.split("/").at(-1);
    if (!listId) throw new Error("Invalid Marketo list URL.");
    listId = decodeURIComponent(listId);
    if (new URL(resourceUrl).href !== new URL(await ui.resourceUrl(listId)).href) {
      throw new Error("This resource belongs to a different Marketo instance. Select its account instead.");
    }
    return { listId };
  },

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
