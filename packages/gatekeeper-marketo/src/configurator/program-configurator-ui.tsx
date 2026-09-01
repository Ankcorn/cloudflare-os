import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  MarketoProgramConfiguratorRpc,
  MarketoProgramConfiguratorValues,
} from "./configurator-types";

export default {
  initial: { programId: null },

  async initialValuesFromResourceUrl({ resourceUrl, ui }) {
    let parsed = new URL(resourceUrl);
    let programId = parsed.pathname.split("/").filter(Boolean).at(-1);
    if (!programId) throw new Error("Invalid Marketo program URL.");
    programId = decodeURIComponent(programId);
    parsed.pathname = parsed.pathname.replace(/\/$/, "");
    if (parsed.href !== new URL(await ui.resourceUrl(programId)).href) {
      throw new Error("This resource belongs to a different Marketo instance. Select its account instead.");
    }
    return { programId };
  },

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
        description="Scopes this connection to one Marketo program: read members and tokens; change membership statuses, metadata, tags, and Email Program dates; approve or unapprove Email Programs; and permanently delete the program. Approving an Email Program may send its configured email to real recipients at its start date."
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
