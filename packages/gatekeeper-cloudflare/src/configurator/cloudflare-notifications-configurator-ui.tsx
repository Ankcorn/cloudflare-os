import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  CloudflareAccountConfiguratorRpc,
  CloudflareNotificationsConfiguratorValues,
} from "./cloudflare-configurator-types";

export default {
  initial: { accountId: null },
  initialValuesFromResourceUrl({ resourceUrl }) {
    const url = new URL(resourceUrl);
    const accountId = url.pathname.split("/")[1];
    return url.origin === "https://dash.cloudflare.com" && /^[a-f0-9]{32}$/i.test(accountId ?? "")
      ? { accountId }
      : {};
  },
  isReady: ({ values }) => /^[a-f0-9]{32}$/i.test(values.accountId ?? ""),
  resourceUrl: ({ values }) =>
    `https://dash.cloudflare.com/${encodeURIComponent(values.accountId!)}/notifications`,
  render({ values, setValues, ui }) {
    return (
      <Section>
        <Field
          label="Cloudflare account"
          description="Choose the account where this app may configure a notification destination."
        >
          <Autocomplete
            name="accountId"
            value={values.accountId}
            placeholder="Choose an account"
            loadOptions={(query) => ui.listAccounts(query)}
            onChange={(accountId) => setValues({ accountId })}
          />
        </Field>
      </Section>
    );
  },
} satisfies ConfiguratorUISpec<
  CloudflareAccountConfiguratorRpc,
  CloudflareNotificationsConfiguratorValues
>;
