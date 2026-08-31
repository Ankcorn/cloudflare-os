import { describe, expect, it } from "vitest";
import {
  MarketoDesignerEmailImpl,
  MarketoDesignerFragmentImpl,
  type EmailDesignerContext,
} from "../src/email-designer";
import {
  designerCloneSnapshot,
  updateDesignerCloneSnapshot,
  type EmailDesignerAction,
  type EmailDesignerActionInput,
} from "../src/email-designer-actions";
import type { MarketoClient } from "../src/marketo-api";

function context(client: Partial<MarketoClient>) {
  let actions: EmailDesignerAction[] = [];
  let ctx: EmailDesignerContext = {
    client: async () => client as MarketoClient,
    observe: async () => {},
    submit: async () => {},
    dispose: () => {},
    retain: () => {},
    allocateProvisional: () => "~1",
    logicalKind: () => undefined,
    pendingDesigner: () => actions,
    resolveDesignerId: id => id,
    submitDesigner: async (action: EmailDesignerActionInput) => {
      actions.push({ ...action, id: actions.length + 1 } as EmailDesignerAction);
    },
  };
  return { actions, ctx };
}

describe("Email Designer pending-state simulation", () => {
  it("preserves untouched content channels and text fields across partial updates", async () => {
    let { ctx } = context({
      getDesignerAsset: async () => ({
        id: "email-1",
        data: {
          html: { body: "<p>Original</p>" },
          text: { body: "Original", syncFromHtml: false },
        },
      }),
    });
    let email = new MarketoDesignerEmailImpl(ctx, "email-1");

    await email.update({ content: { html: "<p>Changed</p>" } });
    await email.update({ content: { syncTextFromHtml: true } });

    expect((await email.describe()).content).toEqual({
      html: "<p>Changed</p>",
      text: "Original",
      syncTextFromHtml: true,
    });
  });

  it("projects pending fragment settings onto the public fragment detail shape", async () => {
    let { actions, ctx } = context({
      getDesignerAsset: async () => ({
        id: "fragment-1",
        settings: {
          fragmentType: "email",
          fragmentSubType: "hero",
          supportedChannels: ["email"],
        },
      }),
    });
    let fragment = new MarketoDesignerFragmentImpl(ctx, "fragment-1");

    await fragment.update({ fragmentSubType: "footer" });
    expect((actions[0] as Extract<EmailDesignerAction, { type: "designerUpdate" }>).patch.settings)
      .toEqual({ fragmentSubType: "footer" });
    expect(await fragment.describe()).toMatchObject({
      fragmentType: "email",
      fragmentSubType: "footer",
      supportedChannels: ["email"],
    });

    await fragment.update({ supportedChannels: ["email", "web"] });
    expect(await fragment.describe()).toMatchObject({
      fragmentSubType: "footer",
      supportedChannels: ["email", "web"],
    });
  });

  it("preserves partial content and settings siblings in pending clone snapshots", () => {
    let snapshot = designerCloneSnapshot({
      data: {
        html: { body: "<p>Original</p>" },
        text: { body: "Original", syncFromHtml: false },
      },
      settings: { fragmentType: "email", supportedChannels: ["email"] },
    });

    expect(updateDesignerCloneSnapshot(snapshot, {
      data: { html: { body: "<p>Changed</p>" } },
      settings: { fragmentSubType: "hero", supportedChannels: undefined },
    })).toEqual(designerCloneSnapshot({
      data: {
        html: { body: "<p>Changed</p>" },
        text: { body: "Original", syncFromHtml: false },
      },
      settings: {
        fragmentType: "email",
        fragmentSubType: "hero",
        supportedChannels: ["email"],
      },
    }));
  });
});
