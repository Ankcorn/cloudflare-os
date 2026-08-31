import { describe, expect, it, vi } from "vitest";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import type { RpcStub } from "cloudflare:workers";
import { MarketoProgramImpl, MarketoSessionImpl, makeSessionContext, type CampaignContext } from "../src/session";
import type { MarketoClient } from "../src/marketo-api";
import type { ProgramAction } from "../src/program-actions";

function programContext(actions: ProgramAction[], client: Partial<MarketoClient>, observations: string[] = []) {
  return {
    client: async () => client as MarketoClient,
    observe: async (title: string) => void observations.push(title),
    submit: async () => {},
    retain: () => {},
    dispose: () => {},
    pendingProgram: () => actions,
    submitProgram: async () => {},
    pendingCampaign: () => [],
    submitCampaign: async () => {},
    pending: () => [],
    submitDesign: async () => {},
    allocateProvisional: () => "~99",
    resolveId: (id: string) => /^\d+$/.test(id) ? Number(id) : undefined,
    logicalKind: () => undefined,
  } as CampaignContext;
}

describe("program pending overlays", () => {
  it("simulates empty reads for a pending program creation without contacting Marketo", async () => {
      let client = {
        getProgramTokens: vi.fn(),
        getProgramMembers: vi.fn(),
      };
      let creation: ProgramAction = {
        id: 1,
        type: "programCreate",
        provisionalId: "~1",
        parentId: "10",
        input: { name: "Pending", type: "Default", channel: "Default" },
      };
      let program = new MarketoProgramImpl(programContext([creation], client), "~1");

      await expect(program.getTokens()).resolves.toEqual([]);
      await expect(program.getMembers()).resolves.toEqual({ members: [], moreResult: false });
      expect(client.getProgramTokens).not.toHaveBeenCalled();
      expect(client.getProgramMembers).not.toHaveBeenCalled();
  });

  it("fails pending clone reads intentionally without contacting Marketo", async () => {
    let client = {
      getProgramTokens: vi.fn(),
      getProgramMembers: vi.fn(),
    };
    let clone: ProgramAction = {
      id: 1,
      type: "programClone",
      provisionalId: "~1",
      sourceId: "7",
      parentId: "10",
      name: "Pending clone",
    };
    let program = new MarketoProgramImpl(programContext([clone], client), "~1");

    await expect(program.getTokens()).rejects.toThrow(/pending cloning/);
    await expect(program.getMembers()).rejects.toThrow(/pending cloning/);
    expect(client.getProgramTokens).not.toHaveBeenCalled();
    expect(client.getProgramMembers).not.toHaveBeenCalled();
  });

  it("makes a pending-deleted program unreadable before any provider request", async () => {
    let client = {
      getProgramTokens: vi.fn(),
      getProgramMembers: vi.fn(),
    };
    let deleted: ProgramAction = {
      id: 1,
      type: "programLifecycle",
      targetId: "7",
      programName: "Deleted",
      operation: "delete",
    };
    let program = new MarketoProgramImpl(programContext([deleted], client), 7);

    await expect(program.getTokens()).rejects.toThrow("Marketo program 7 was not found.");
    await expect(program.getMembers()).rejects.toThrow("Marketo program 7 was not found.");
    expect(client.getProgramTokens).not.toHaveBeenCalled();
    expect(client.getProgramMembers).not.toHaveBeenCalled();
  });
});

describe("session child capability lifetime", () => {
  it("keeps every child family usable after disposing its parents and releases the queue once", async () => {
    let queueDisposals = 0;
    let queue = {
      async authorizeObservation() {},
      [Symbol.dispose]() { queueDisposals++; },
    } as unknown as RpcStub<ApprovalQueue>;
    let base = makeSessionContext({
      approvalQueue: queue,
      submit: async () => {},
      client: async () => ({
        getLeads: async () => [],
        getList: async () => ({ id: 2, name: "List" }),
        getProgramTokens: async () => [],
        getSmartCampaign: async () => ({ id: 4, name: "Campaign" }),
        describeCustomObject: async () => ({ name: "object", fields: [] }),
        describeBusinessObject: async () => ({ name: "Company", fields: [] }),
        getEmail: async () => ({ id: 7, name: "Classic email" }),
        getDesignerAsset: async () => ({ id: "designer-8", name: "Designer email" }),
      }) as unknown as MarketoClient,
    });
    let ctx = {
      ...base,
      allocateProvisional: () => "~1",
      pending: () => [],
      resolveId: (id: string) => /^\d+$/.test(id) ? Number(id) : undefined,
      logicalKind: () => undefined,
      submitDesign: async () => {},
      pendingCampaign: () => [],
      submitCampaign: async () => {},
      pendingProgram: () => [],
      submitProgram: async () => {},
      pendingDesigner: () => [],
      resolveDesignerId: (id: string) => id,
      submitDesigner: async () => {},
      submitBusinessObject: async () => {},
      getBusinessObjectAccess: () => "read-write" as const,
      setBusinessObjectAccess: () => {},
    };
    let session = new MarketoSessionImpl(ctx);
    let person = session.getPerson({ field: "id", value: "1" });
    let list = session.getStaticList(2);
    let program = session.getProgram(3);
    let campaign = session.getSmartCampaign(4);
    let customObject = session.getCustomObject("object");
    let businessObject = session.getBusinessObject("company");
    let studio = session.getDesignStudio();
    let classicEmail = studio.getEmail("7");
    let designer = studio.getEmailDesigner();
    let designerEmail = designer.getEmail("designer-8");

    designer[Symbol.dispose]();
    studio[Symbol.dispose]();
    session[Symbol.dispose]();
    expect(queueDisposals).toBe(0);

    await expect(person.read()).resolves.toBeNull();
    await expect(list.describe()).resolves.toMatchObject({ id: 2 });
    await expect(program.getTokens()).resolves.toEqual([]);
    await expect(campaign.describe()).resolves.toMatchObject({ id: 4 });
    await expect(customObject.describe()).resolves.toMatchObject({ apiName: "object" });
    await expect(businessObject.describe()).resolves.toMatchObject({ kind: "company" });
    await expect(classicEmail.describe()).resolves.toMatchObject({ id: "7" });
    await expect(designerEmail.describe()).resolves.toMatchObject({ id: "designer-8" });

    for (let child of [
      person, list, program, campaign, customObject, businessObject, classicEmail, designerEmail,
    ]) child[Symbol.dispose]();
    person[Symbol.dispose]();
    expect(queueDisposals).toBe(1);
  });
});
