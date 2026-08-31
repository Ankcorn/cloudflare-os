import { describe, expect, it } from "vitest";
import {
  MarketoEmailDesignerImpl,
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

function context(
  client: Partial<MarketoClient>,
  initial: EmailDesignerAction[] = [],
  resolveDesignerId: (id: string) => string | undefined = id => id,
) {
  let actions = [...initial];
  let ctx: EmailDesignerContext = {
    client: async () => client as MarketoClient,
    observe: async () => {},
    submit: async () => {},
    dispose: () => {},
    retain: () => {},
    allocateProvisional: () => "~1",
    logicalKind: () => undefined,
    pendingDesigner: () => actions,
    resolveDesignerId,
    submitDesigner: async (action: EmailDesignerActionInput) => {
      actions.push({ ...action, id: actions.length + 1 } as EmailDesignerAction);
    },
  };
  return { actions, ctx };
}

describe("Email Designer pending-state simulation", () => {
  it("includes pending creates and clones that match list filters", async () => {
    let { ctx } = context({
      filterDesignerAssets: async () => ({ items: [], totalItems: 0, currentPage: 0, pageSize: 50 }),
      getDesignerAsset: async (_kind, id) => id === "source" ? {
        id, name: "Source", status: "approved", templateId: "template-1",
        appData: { workspaceId: "1", folderId: "10" },
      } : undefined,
    }, [
      {
        id: 1, type: "designerCreate", asset: "designerEmail", provisionalId: "~1",
        body: { name: "Created", status: "draft", templateId: "template-1", appData: { workspaceId: "1", folderId: "10" } },
      },
      {
        id: 2, type: "designerClone", asset: "designerEmail", provisionalId: "~2", sourceId: "source",
        name: "Cloned", sourceSnapshot: designerCloneSnapshot({}),
      },
    ]);
    let designer = new MarketoEmailDesignerImpl(ctx);

    expect((await designer.listEmails("1", {
      folderId: "10", name: "Created", status: ["draft"], templateId: "template-1",
    })).items.map(item => item.id)).toEqual(["~1"]);
    expect((await designer.listEmails("1", {
      folderId: "10", name: "Cloned", status: ["draft"], templateId: "template-1",
    })).items.map(item => item.id)).toEqual(["~2"]);
  });

  it("applies fragment filters to pending creates", async () => {
    let { ctx } = context({
      filterDesignerAssets: async () => ({ items: [], totalItems: 0, currentPage: 0, pageSize: 50 }),
    }, [{
      id: 1, type: "designerCreate", asset: "designerFragment", provisionalId: "~1",
      body: {
        name: "Hero", appData: { workspaceId: "1", folderId: "10" },
        settings: { fragmentType: "email", supportedChannels: ["email"] },
      },
    }]);

    expect((await new MarketoEmailDesignerImpl(ctx).listFragments("1", {
      folderId: "10", name: "Hero", status: ["draft"], fragmentType: "email",
    })).items.map(item => item.id)).toEqual(["~1"]);
  });

  it("adds an updated upstream item that now matches the filter", async () => {
    let { ctx } = context({
      filterDesignerAssets: async () => ({ items: [], totalItems: 0, currentPage: 0, pageSize: 50 }),
      getDesignerAsset: async () => ({
        id: "email-1", name: "Old", status: "draft", appData: { workspaceId: "1", folderId: "10" },
      }),
    }, [{
      id: 1, type: "designerUpdate", asset: "designerEmail", targetId: "email-1", patch: { name: "New" },
    }]);

    expect(await new MarketoEmailDesignerImpl(ctx).listEmails("1", { name: "New" })).toMatchObject({
      items: [{ id: "email-1", name: "New" }], totalItems: 1,
    });
  });

  it("masks pending deletes from items and totals", async () => {
    let { ctx } = context({
      filterDesignerAssets: async () => ({
        items: [{ id: "email-1", name: "Delete me", appData: { workspaceId: "1" } }],
        totalItems: 1, currentPage: 0, pageSize: 50,
      }),
    }, [{ id: 1, type: "designerDelete", asset: "designerEmail", targetId: "email-1" }]);

    expect(await new MarketoEmailDesignerImpl(ctx).listEmails("1")).toMatchObject({ items: [], totalItems: 0 });
  });

  it("substitutes a resolved provisional item without duplicating it", async () => {
    let { ctx } = context({
      filterDesignerAssets: async () => ({
        items: [{ id: "email-99", name: "Created", status: "draft", appData: { workspaceId: "1" } }],
        totalItems: 1, currentPage: 0, pageSize: 50,
      }),
    }, [{
      id: 1, type: "designerCreate", asset: "designerEmail", provisionalId: "~1",
      body: { name: "Created", appData: { workspaceId: "1" } },
    }], id => id === "~1" ? "email-99" : id);

    expect((await new MarketoEmailDesignerImpl(ctx).listEmails("1")).items.map(item => item.id)).toEqual(["~1"]);
  });

  it("merges before sorting and paginating across upstream pages", async () => {
    let requestedPages: number[] = [];
    let pages = [
      [{ id: "a", name: "Alpha" }, { id: "b", name: "Bravo" }],
      [{ id: "c", name: "Charlie" }, { id: "d", name: "Delta" }],
    ];
    let { ctx } = context({
      filterDesignerAssets: async (_kind, options) => {
        let page = options.pageIndex ?? 0;
        requestedPages.push(page);
        return {
          items: (pages[page] ?? []).map(item => ({ ...item, status: "draft", appData: { workspaceId: "1" } })),
          totalItems: 4, currentPage: page, pageSize: 2,
        };
      },
      getDesignerAsset: async (_kind, id) => ({
        id, name: id === "c" ? "Charlie" : "", status: "draft", appData: { workspaceId: "1" },
      }),
    }, [
      { id: 1, type: "designerDelete", asset: "designerEmail", targetId: "b" },
      { id: 2, type: "designerUpdate", asset: "designerEmail", targetId: "c", patch: { name: "Able" } },
    ]);
    let designer = new MarketoEmailDesignerImpl(ctx);

    let first = await designer.listEmails("1", { pageSize: 2, sortKey: "name", sortOrder: "ASC" });
    let second = await designer.listEmails("1", { pageIndex: 1, pageSize: 2, sortKey: "name", sortOrder: "ASC" });

    expect(first).toMatchObject({ items: [{ id: "c" }, { id: "a" }], totalItems: 3, pageIndex: 0, pageSize: 2 });
    expect(second).toMatchObject({ items: [{ id: "d" }], totalItems: 3, pageIndex: 1, pageSize: 2 });
    expect(requestedPages).toEqual([0, 1, 0, 1]);
  });

  it("deduplicates overlapping upstream pages before local pagination", async () => {
    let requestedPages: number[] = [];
    let pages = [
      [{ id: "a", name: "Alpha" }, { id: "b", name: "Bravo" }],
      [{ id: "b", name: "Duplicate Bravo" }, { id: "c", name: "Charlie" }],
      [{ id: "d", name: "Delta" }],
    ];
    let { ctx } = context({
      filterDesignerAssets: async (_kind, options) => {
        let page = options.pageIndex ?? 0;
        requestedPages.push(page);
        return {
          items: (pages[page] ?? []).map(item => ({ ...item, status: "draft", appData: { workspaceId: "1" } })),
          totalItems: 4, currentPage: page, pageSize: 2,
        };
      },
      getDesignerAsset: async (_kind, id) => ({
        id, name: "Charlie", status: "draft", appData: { workspaceId: "1" },
      }),
    }, [{
      id: 1, type: "designerUpdate", asset: "designerEmail", targetId: "c", patch: { name: "Updated Charlie" },
    }]);
    let designer = new MarketoEmailDesignerImpl(ctx);

    let first = await designer.listEmails("1", { pageSize: 2 });
    let second = await designer.listEmails("1", { pageIndex: 1, pageSize: 2 });

    expect(first).toMatchObject({ items: [{ id: "a" }, { id: "b", name: "Bravo" }], totalItems: 4 });
    expect(second).toMatchObject({ items: [{ id: "c", name: "Updated Charlie" }, { id: "d" }], totalItems: 4 });
    expect(requestedPages).toEqual([0, 1, 2, 0, 1, 2]);
  });

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
