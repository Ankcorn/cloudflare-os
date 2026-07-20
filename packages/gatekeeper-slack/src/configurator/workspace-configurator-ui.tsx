import { Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  WorkspaceConfiguratorRpc, WorkspaceConfiguratorValues,
} from "./workspace-configurator-types";

export default {
  initial: {},

  isReady() {
    return true;
  },

  async resourceUrl({ ui }) {
    return await ui.getWorkspaceUrl();
  },

  render() {
    return <Section>
      <Field
        label="Whole workspace"
        description="This connection lets the gadget read the channels and direct messages you can access, the workspace's members, and message search."
      >
        <span />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<WorkspaceConfiguratorRpc, WorkspaceConfiguratorValues>;
