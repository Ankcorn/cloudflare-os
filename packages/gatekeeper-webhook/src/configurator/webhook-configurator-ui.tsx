import { Field, h, Section, TextInput, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { WebhookConfiguratorRpc, WebhookConfiguratorValues } from "./webhook-configurator-types";

export default {
  initial: { endpointId: crypto.randomUUID(), label: null },
  isReady: ({ values }) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(values.endpointId ?? ""),
  async initialValuesFromResourceUrl({ resourceUrl, ui }) {
    const endpointId = new URL(resourceUrl).pathname.split("/").filter(Boolean).at(-1);
    if (!endpointId) return {};
    const decodedEndpointId = decodeURIComponent(endpointId);
    try {
      return { endpointId: decodedEndpointId, label: await ui.getLabel(decodedEndpointId) };
    } catch {
      // Do not leave the randomly-generated default ready after a concrete URL failed to load.
      return { endpointId: null, label: null };
    }
  },
  resourceUrl: ({ values, ui }) => ui.resourceUrl(values.endpointId, values.label),
  render({ values, setValues }) {
    return <Section title="Private webhook endpoint">
      <Field label="Label" description="Optional name shown in Connections." optional>
        <TextInput
          name="label"
          value={values.label}
          placeholder="Webhook endpoint"
          optional
          onChange={label => setValues({ label })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<WebhookConfiguratorRpc, WebhookConfiguratorValues>;
