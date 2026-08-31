import { describe, expect, it } from "vitest";
import type { CampaignAction, CampaignActionInput } from "../src/campaign-actions";
import type { DesignStudioAction, DesignStudioActionInput } from "../src/design-studio-actions";
import { MarketoDesignStudioImpl } from "../src/design-studio";
import type { MarketoClient } from "../src/marketo-api";
import type { ProgramAction, ProgramActionInput } from "../src/program-actions";
import { MarketoSessionImpl, type CampaignContext } from "../src/session";

function context(client: Partial<MarketoClient>) {
  let designActions: DesignStudioAction[] = [];
  let campaignActions: CampaignAction[] = [];
  let programActions: ProgramAction[] = [];
  let nextAction = 0;
  let nextProvisional = 0;
  let ctx: CampaignContext = {
    client: async () => client as MarketoClient,
    observe: async () => {},
    submit: async () => {},
    retain: () => {},
    dispose: () => {},
    allocateProvisional: () => `~${++nextProvisional}`,
    logicalKind: id => {
      let creation = [...designActions, ...campaignActions, ...programActions].find(action =>
        "provisionalId" in action && action.provisionalId === id
      );
      if (!creation) return undefined;
      if (creation.type === "campaignCreate" || creation.type === "campaignClone") return "campaign";
      if (creation.type === "programCreate" || creation.type === "programClone") return "program";
      if (creation.type === "designCreate" || creation.type === "designClone") return creation.asset;
      return undefined;
    },
    resolveId: id => /^\d+$/.test(id) ? Number(id) : undefined,
    pending: () => designActions,
    submitDesign: async (input: DesignStudioActionInput) => {
      designActions.push({ ...input, id: ++nextAction } as DesignStudioAction);
    },
    pendingCampaign: () => campaignActions,
    submitCampaign: async (input: CampaignActionInput) => {
      campaignActions.push({ ...input, id: ++nextAction } as CampaignAction);
    },
    pendingProgram: () => programActions,
    submitProgram: async (input: ProgramActionInput) => {
      programActions.push({ ...input, id: ++nextAction } as ProgramAction);
    },
  };
  return ctx;
}

describe("classic clone simulation action boundaries", () => {
  it("freezes inherited Design Studio metadata and content at the clone action", async () => {
    let ctx = context({
      getEmailTemplate: async () => ({ id: 31, name: "Source", description: "Original", status: "approved" }),
      getEmailTemplateContent: async () => ({ id: 31, content: "original" }),
    });
    let studio = new MarketoDesignStudioImpl(ctx);
    let source = studio.getEmailTemplate("31");

    await source.updateMetadata({ description: "Before clone" });
    await source.updateContent("before clone");
    let clone = await studio.cloneEmailTemplate("31", "Clone", { id: "10", type: "folder" });
    await source.updateMetadata({ description: "After clone" });
    await source.updateContent("after clone");

    expect(await clone.describe()).toMatchObject({ name: "Clone", description: "Before clone" });
    expect(await clone.getContent()).toBe("before clone");
    expect(await source.describe()).toMatchObject({ description: "After clone" });
    expect(await source.getContent()).toBe("after clone");
  });

  it("keeps campaign metadata and rules readable after a post-clone source deletion", async () => {
    let ctx = context({
      getSmartCampaign: async () => ({
        id: 7,
        name: "Source",
        description: "Original",
        type: "trigger",
        smartListId: 8,
      }),
      getCampaignSmartList: async () => ({
        id: 8,
        rules: { triggers: [{ id: 1, name: "Person is Created" }], filters: [] },
      }),
    });
    let session = new MarketoSessionImpl(ctx);
    let source = session.getSmartCampaign("7");

    await source.updateMetadata({ description: "Before clone" });
    let clone = await session.cloneSmartCampaign("7", { id: "10", type: "folder" }, { name: "Clone" });
    await source.delete();

    expect(await clone.describe()).toMatchObject({ name: "Clone", description: "Before clone" });
    expect(await clone.readSmartListRules()).toMatchObject({
      triggers: [{ id: 1, name: "Person is Created" }],
      filters: [],
    });
  });

  it("freezes inherited program metadata at the clone action", async () => {
    let ctx = context({
      getProgram: async () => ({
        id: 7,
        name: "Source",
        description: "Original",
        type: "Default",
        channel: "Web",
      }),
      getChannels: async () => [{ name: "Web", applicableProgramType: "Default" }],
    });
    let session = new MarketoSessionImpl(ctx);
    let source = session.getProgram("7");

    await source.updateMetadata({ description: "Before clone" });
    let clone = await session.cloneProgram("7", { id: "10", type: "folder" }, { name: "Clone" });
    await source.updateMetadata({ description: "After clone" });

    expect(await clone.describe()).toMatchObject({ name: "Clone", description: "Before clone" });
    expect(await source.describe()).toMatchObject({ description: "After clone" });
  });
});
