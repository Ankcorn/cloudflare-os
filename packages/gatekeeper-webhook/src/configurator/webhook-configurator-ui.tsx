import { Field, h, Section, TextInput, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { WebhookConfiguratorRpc, WebhookConfiguratorValues } from "./webhook-configurator-types";

export default {
  initial: { endpointId: crypto.randomUUID(), label: null },
  isReady: () => true,
  async initialValuesFromResourceUrl({ resourceUrl, ui }) {
    const endpointId = new URL(resourceUrl).pathname.split("/").filter(Boolean).at(-1);
    if (!endpointId) return {};
    const decodedEndpointId = decodeURIComponent(endpointId);
    return {
      endpointId: decodedEndpointId,
      label: await ui.getLabel(decodedEndpointId),
    };
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
