import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  MarketoProgramConfiguratorRpc,
  MarketoProgramConfiguratorValues,
} from "./configurator-types";

export default {
  initial: { programId: null },

  isReady({ values }) {
    return Boolean(values.programId);
  },

  resourceUrl({ values, ui }) {
    return ui.resourceUrl(values.programId);
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field
        label="Program"
        description="Scopes this connection to one Marketo program: read members and tokens; change membership statuses, metadata, tags, and Email Program dates; approve or unapprove Email Programs; and permanently delete the program."
      >
        <Autocomplete
          name="programId"
          value={values.programId}
          placeholder="Search programs…"
          loadOptions={(query) => ui.listPrograms(query)}
          onChange={(programId) => setValues({ programId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<MarketoProgramConfiguratorRpc, MarketoProgramConfiguratorValues>;
