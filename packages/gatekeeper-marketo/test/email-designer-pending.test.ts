import { describe, expect, it } from "vitest";
import {
  MarketoEmailDesignerImpl,
  MarketoDesignerEmailImpl,
  MarketoDesignerEmailTemplateImpl,
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
  it("returns summary-only list items", async () => {
    let { ctx } = context({
      filterDesignerAssets: async () => ({
        items: [{
          id: "email-1", name: "Email", appData: { workspaceId: "1", folderId: "10" },
          headers: { subject: "Secret" }, data: { html: { body: "Secret body" } },
          settings: { isOperational: true }, templateId: "template-1",
        }],
        totalItems: 1, currentPage: 0, pageSize: 20,
      }),
    });

    let item = (await new MarketoEmailDesignerImpl(ctx).listEmails("1")).items[0];
    expect(item).toEqual({
      id: "email-1", name: "Email", description: undefined, status: undefined,
      workspaceId: "1", folderId: "10", createdBy: undefined, createdAt: undefined,
      modifiedBy: undefined, modifiedAt: undefined,
    });
    expect(item).not.toHaveProperty("content");
    expect(item).not.toHaveProperty("headers");
    expect(item).not.toHaveProperty("settings");
  });

  it("rejects unrelated direct-list rows and provider pages before observation", async () => {
    let observations = 0;
    let { ctx } = context({
      filterDesignerAssets: async () => ({
        items: [{ id: "email-1", name: "Wrong", appData: { workspaceId: "other" } }],
        totalItems: 1, currentPage: 0, pageSize: 20,
      }),
    });
    ctx.observe = async () => { observations++; };
    let designer = new MarketoEmailDesignerImpl(ctx);

    await expect(designer.listEmails("1", { name: "Expected" }))
      .rejects.toThrow(/outside the requested list filters/);
    expect(observations).toBe(0);

    ctx.client = async () => ({
      filterDesignerAssets: async () => ({ items: [], totalItems: 0, currentPage: 1, pageSize: 20 }),
    }) as unknown as MarketoClient;
    await expect(designer.listEmails("1", { pageIndex: 0 }))
      .rejects.toThrow(/page 1 when page 0 was requested/);
    expect(observations).toBe(0);
  });

  it("validates every upstream row against list filters when pending actions exist", async () => {
    let cases: {
      kind: "email" | "fragment";
      workspace: string;
      folderId?: string;
      name?: string;
      status?: string;
      templateId?: string;
      fragmentType?: string;
      options: { folderId?: string; name?: string; status?: string[]; templateId?: string; fragmentType?: string };
    }[] = [
      { kind: "email", workspace: "2", options: {} },
      { kind: "email", workspace: "1", folderId: "11", options: { folderId: "10" } },
      { kind: "email", workspace: "1", folderId: "10", name: "Other", options: { name: "Expected" } },
      { kind: "email", workspace: "1", folderId: "10", status: "approved", options: { status: ["draft"] } },
      { kind: "email", workspace: "1", folderId: "10", templateId: "template-2", options: { templateId: "template-1" } },
      { kind: "fragment", workspace: "1", folderId: "10", fragmentType: "web", options: { fragmentType: "email" } },
    ];

    for (let [index, testCase] of cases.entries()) {
      let observations = 0;
      let asset: EmailDesignerAction["asset"] = testCase.kind === "fragment" ? "designerFragment" : "designerEmail";
      let { ctx } = context({
        getDesignerAsset: async () => ({
          id: "pending-target", name: "Expected", status: "draft", templateId: "template-1",
          appData: { workspaceId: "1", folderId: "10" }, settings: { fragmentType: "email" },
        }),
        filterDesignerAssets: async () => ({
          items: [{
            id: `asset-${index}`,
            name: "name" in testCase ? testCase.name : "Expected",
            status: "status" in testCase ? testCase.status : "draft",
            templateId: "templateId" in testCase ? testCase.templateId : "template-1",
            appData: { workspaceId: testCase.workspace, folderId: testCase.folderId },
            settings: { fragmentType: "fragmentType" in testCase ? testCase.fragmentType : "email" },
          }],
          totalItems: 1, currentPage: 0, pageSize: 50,
        }),
      }, [{ id: 1, type: "designerDelete", asset, targetId: "pending-target" }]);
      ctx.observe = async () => { observations++; };
      let designer = new MarketoEmailDesignerImpl(ctx);

      let listing = testCase.kind === "fragment"
        ? designer.listFragments("1", testCase.options)
        : designer.listEmails("1", testCase.options);
      await expect(listing).rejects.toThrow(/outside the requested list filters/);
      expect(observations).toBe(0);
    }
  });

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
        name: "Cloned", sourceSnapshot: designerCloneSnapshot({
          templateId: "template-1", appData: { workspaceId: "1", folderId: "10" },
        }),
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
      getDesignerAsset: async () => ({ id: "email-1", name: "Delete me", appData: { workspaceId: "1" } }),
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

  it("materializes the same bounded collection before paginating equal sort keys", async () => {
    let requestedPages: number[] = [];
    let listCall = -1;
    let orders = [["d", "b", "a", "c"], ["c", "a", "b", "d"]];
    let { ctx } = context({
      filterDesignerAssets: async (_kind, options) => {
        let page = options.pageIndex ?? 0;
        if (page === 0) listCall++;
        requestedPages.push(page);
        let ids = orders[listCall]!.slice(page * 2, page * 2 + 2);
        return {
          items: ids.map(id => ({ id, name: "Same", status: "draft", appData: { workspaceId: "1" } })),
          totalItems: 4, currentPage: page, pageSize: 2,
        };
      },
      getDesignerAsset: async () => ({
        id: "pending", name: "Same", status: "draft", appData: { workspaceId: "1" },
      }),
    }, [{ id: 1, type: "designerDelete", asset: "designerEmail", targetId: "pending" }]);
    let designer = new MarketoEmailDesignerImpl(ctx);

    let first = await designer.listEmails("1", { pageSize: 2, sortKey: "name" });
    let second = await designer.listEmails("1", { pageIndex: 1, pageSize: 2, sortKey: "name" });

    expect(first.items.map(item => item.id)).toEqual(["a", "b"]);
    expect(second.items.map(item => item.id)).toEqual(["c", "d"]);
    expect(requestedPages).toEqual([0, 1, 0, 1]);
  });

  it("rejects oversized sorted pending collections without aggregating them", async () => {
    let requestedPages: number[] = [];
    let { ctx } = context({
      filterDesignerAssets: async (_kind, options) => {
        requestedPages.push(options.pageIndex ?? 0);
        return { items: [], totalItems: 1_001, currentPage: 0, pageSize: 50 };
      },
      getDesignerAsset: async () => ({ id: "pending", name: "Pending", appData: { workspaceId: "1" } }),
    }, [{ id: 1, type: "designerDelete", asset: "designerEmail", targetId: "pending" }]);

    await expect(new MarketoEmailDesignerImpl(ctx).listEmails("1", { sortKey: "name" }))
      .rejects.toThrow(/cannot exceed 1000 assets/);
    expect(requestedPages).toEqual([0]);
  });

  it("rejects a wrong page while collecting pages for a pending overlay", async () => {
    let { ctx } = context({
      filterDesignerAssets: async (_kind, options) => {
        let requested = options.pageIndex ?? 0;
        return {
          items: [{
            id: `email-${requested}`,
            name: `Email ${requested}`,
            status: "draft",
            appData: { workspaceId: "1" },
          }],
          totalItems: 2,
          currentPage: 0,
          pageSize: 1,
        };
      },
      getDesignerAsset: async () => ({
        id: "pending", name: "Pending", status: "draft", appData: { workspaceId: "1" },
      }),
    }, [{ id: 1, type: "designerDelete", asset: "designerEmail", targetId: "pending" }]);

    await expect(new MarketoEmailDesignerImpl(ctx).listEmails("1", { pageIndex: 1, pageSize: 1 }))
      .rejects.toThrow(/page 0 when page 1 was requested/);
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
    expect(requestedPages).toEqual([0, 0, 1, 2]);
  });

  it("uses the persisted clone snapshot without rereading later source state", async () => {
    let sourceReads = 0;
    let snapshot = designerCloneSnapshot({
      templateId: "~template",
      appData: { workspaceId: "1", folderId: "~folder" },
      data: { html: { body: "<p>At clone time</p>" } },
    });
    let { ctx } = context({
      filterDesignerAssets: async () => ({ items: [], totalItems: 0, currentPage: 0, pageSize: 50 }),
      getDesignerAsset: async () => {
        sourceReads++;
        return { id: "source", data: { html: { body: "Later live content" } } };
      },
    }, [
      { id: 1, type: "designerUpdate", asset: "designerEmail", targetId: "source", patch: { name: "Before clone" } },
      { id: 2, type: "designerClone", asset: "designerEmail", provisionalId: "~clone", sourceId: "source", name: "Copy", sourceSnapshot: snapshot },
      { id: 3, type: "designerUpdate", asset: "designerEmail", targetId: "source", patch: { data: { html: { body: "After clone" } } } },
    ], value => value === "~template" ? "template-42" : value);
    ctx.resolveAssetId = value => value === "~folder" ? 17 : undefined;

    let result = await new MarketoDesignerEmailImpl(ctx, "~clone").describe();

    expect(result).toMatchObject({
      name: "Copy",
      templateId: "template-42",
      folderId: "17",
      content: { html: "<p>At clone time</p>" },
      status: "draft",
    });
    expect(sourceReads).toBe(0);
  });

  it.each([
    ["approve", "draft", "approved"],
    ["unapprove", "approved", "draft"],
  ] as const)("snapshots a pending %s before a later clone", async (operation, sourceState, targetState) => {
    let raw = {
      id: "email-1",
      name: "Source",
      status: sourceState,
      state: sourceState,
      contentId: "content-1",
      associatedStates: [{ contentId: "content-1", state: sourceState }],
      data: { html: { body: "<p>Source</p>" } },
    };
    let { actions, ctx } = context({
      getDesignerAsset: async () => raw,
      getDesignerAssetUsedBy: async () => ({
        result: [], pageDetails: { totalItems: 0, currentPage: 1, pageSize: 50 },
      }),
    });
    let email = new MarketoDesignerEmailImpl(ctx, "email-1");

    await email[operation]();
    await email.clone("Copy");

    let clone = actions[1] as Extract<EmailDesignerAction, { type: "designerClone" }>;
    expect(clone.sourceSnapshot).toEqual(designerCloneSnapshot({
      ...raw,
      status: targetState,
      state: targetState,
      associatedStates: [{ contentId: "content-1", state: targetState }],
    }));
    expect(raw).toMatchObject({
      status: sourceState,
      state: sourceState,
      associatedStates: [{ contentId: "content-1", state: sourceState }],
    });
  });

  it("snapshots complete publishable Designer state and affected dependents", async () => {
    let raw = {
      id: "fragment-1",
      name: "Hero",
      status: "draft",
      state: "draft",
      contentId: "draft-1",
      associatedStates: [{ contentId: "draft-1", state: "draft" }],
      data: { html: { body: "<section>Hero</section>" }, text: { body: "Hero" } },
      headers: { subject: "Hero subject" },
      settings: { fragmentType: "email", supportedChannels: ["email"] },
    };
    let { actions, ctx } = context({
      getDesignerAsset: async () => raw,
      getDesignerAssetUsedBy: async () => ({
        result: [{
          id: "email-7", name: "Dependent", contentType: "email",
          appData: { workspaceId: "1", folderId: "10" },
        }],
        pageDetails: { totalItems: 1, currentPage: 1, pageSize: 50 },
      }),
    });

    await new MarketoDesignerFragmentImpl(ctx, "fragment-1").approve();

    expect(actions[0]).toMatchObject({
      sourceSnapshot: designerCloneSnapshot(raw),
      affectedDependents: [{
        id: "email-7", name: "Dependent", contentType: "email",
        workspaceId: "1", folderId: "10",
      }],
    });
  });

  it("rejects every post-delete operation before provider or approval access", async () => {
    let providerReads = 0;
    let providerWrites = 0;
    let { ctx } = context({
      getDesignerAsset: async () => {
        providerReads++;
        return { id: "email-1" };
      },
      getDesignerAssetUsedBy: async () => {
        providerReads++;
        return { result: [] };
      },
    }, [{ id: 1, type: "designerDelete", asset: "designerEmail", targetId: "email-1" }]);
    ctx.submitDesigner = async () => { providerWrites++; };
    let email = new MarketoDesignerEmailImpl(ctx, "email-1");

    await expect(email.update({ name: "No" })).rejects.toThrow(/was deleted/);
    await expect(email.clone("No")).rejects.toThrow(/was deleted/);
    await expect(email.approve()).rejects.toThrow(/was deleted/);
    expect(() => email.delete()).toThrow(/was deleted/);
    await expect(email.getUsedBy()).rejects.toThrow(/was deleted/);
    expect(providerReads).toBe(0);
    expect(providerWrites).toBe(0);

    await expect(email.describe()).rejects.toThrow(/was deleted/);
    expect(providerReads).toBe(1);
  });

  it("moves a pending email template reference from the old used-by set to the new one before paging", async () => {
    let requests: { assetId: string; pageIndex?: number; pageSize?: number }[] = [];
    let { ctx } = context({
      getDesignerAsset: async () => ({
        id: "email-1", name: "Changed email", templateId: "template-A",
        appData: { workspaceId: "1", folderId: "10" },
      }),
      getDesignerAssetUsedBy: async (_kind, request) => {
        requests.push(request);
        let result = request.assetId === "template-A"
          ? [{ id: "email-1", name: "Changed email", contentType: "email" }]
          : [{ id: "other-1", name: "First" }, { id: "other-2", name: "Second" }];
        return {
          result,
          pageDetails: { totalItems: result.length, currentPage: (request.pageIndex ?? 0) + 1, pageSize: request.pageSize },
        };
      },
    });
    await new MarketoDesignerEmailImpl(ctx, "email-1").update({ templateId: "template-B" });

    expect(await new MarketoDesignerEmailTemplateImpl(ctx, "template-A").getUsedBy()).toMatchObject({
      items: [], totalItems: 0,
    });
    let second = await new MarketoDesignerEmailTemplateImpl(ctx, "template-B").getUsedBy(1, 2);
    expect(second).toMatchObject({
      items: [{ id: "email-1", name: "Changed email", workspaceId: "1", folderId: "10" }],
      totalItems: 3, pageIndex: 1, pageSize: 2,
    });
    expect(requests).toEqual([
      { assetId: "template-A", pageIndex: 0, pageSize: 50, type: "all" },
      { assetId: "template-B", pageIndex: 0, pageSize: 50, type: "all" },
    ]);
  });

  it("adds a pending email creation to its template used-by set", async () => {
    let { ctx } = context({
      getDesignerAssetUsedBy: async (_kind, request) => ({
        result: [], pageDetails: { totalItems: 0, currentPage: 1, pageSize: request.pageSize },
      }),
    });
    await new MarketoEmailDesignerImpl(ctx).createEmail({
      location: { workspaceId: "1", folderId: "10" },
      name: "Created email",
      headers: { subject: "Subject" },
      templateId: "template-B",
    });

    expect(await new MarketoDesignerEmailTemplateImpl(ctx, "template-B").getUsedBy()).toMatchObject({
      items: [{ id: "~1", name: "Created email", workspaceId: "1", folderId: "10" }],
      totalItems: 1,
    });
  });

  it("removes a pending email deletion from its template used-by set", async () => {
    let { ctx } = context({
      getDesignerAsset: async () => ({
        id: "email-1", name: "Deleted email", templateId: "template-A",
        appData: { workspaceId: "1" },
      }),
      getDesignerAssetUsedBy: async (_kind, request) => ({
        result: [{ id: "email-1", name: "Deleted email", contentType: "email" }],
        pageDetails: { totalItems: 1, currentPage: 1, pageSize: request.pageSize },
      }),
    });
    await new MarketoDesignerEmailImpl(ctx, "email-1").delete();

    expect(await new MarketoDesignerEmailTemplateImpl(ctx, "template-A").getUsedBy()).toMatchObject({
      items: [], totalItems: 0,
    });
  });

  it("keeps direct paging when pending creates, clones, and deletes belong to other templates", async () => {
    let requests: { assetId: string; pageIndex?: number; pageSize?: number }[] = [];
    let { ctx } = context({
      getDesignerAsset: async (_kind, assetId) => ({ id: assetId, templateId: "template-other" }),
      getDesignerAssetUsedBy: async (_kind, request) => {
        requests.push(request);
        return {
          result: [{ id: "email-page", name: "Paged email" }],
          pageDetails: { totalItems: 1_500, currentPage: (request.pageIndex ?? 0) + 1, pageSize: request.pageSize },
        };
      },
    }, [
      {
        id: 1, type: "designerCreate", asset: "designerEmail", provisionalId: "~1",
        body: { name: "Other create", templateId: "template-other" },
      },
      {
        id: 2, type: "designerClone", asset: "designerEmail", provisionalId: "~2", sourceId: "email-source",
        name: "Other clone", sourceSnapshot: designerCloneSnapshot({ templateId: "template-other" }),
      },
      { id: 3, type: "designerDelete", asset: "designerEmail", targetId: "email-delete" },
    ], id => id.startsWith("~") ? undefined : id);

    expect(await new MarketoDesignerEmailTemplateImpl(ctx, "template-large").getUsedBy(3, 20)).toMatchObject({
      items: [{ id: "email-page", name: "Paged email" }],
      totalItems: 1_500,
      pageIndex: 3,
      pageSize: 20,
    });
    expect(requests).toEqual([
      { assetId: "template-large", pageIndex: 3, pageSize: 20, type: "all" },
    ]);
  });

  it("rejects oversized pending used-by simulation after its first provider page", async () => {
    let requestedPages: number[] = [];
    let { ctx } = context({
      getDesignerAsset: async () => ({ id: "email-1", templateId: "template-A" }),
      getDesignerAssetUsedBy: async (_kind, request) => {
        requestedPages.push(request.pageIndex ?? 0);
        return {
          result: Array.from({ length: 50 }, (_, index) => ({ id: `email-${index}`, name: `Email ${index}` })),
          pageDetails: { totalItems: 1_500, currentPage: 1, pageSize: request.pageSize },
        };
      },
    }, [{ id: 1, type: "designerDelete", asset: "designerEmail", targetId: "email-1" }]);

    await expect(new MarketoDesignerEmailTemplateImpl(ctx, "template-A").getUsedBy())
      .rejects.toThrow(/cannot exceed 1000 provider records/);
    expect(requestedPages).toEqual([0]);
  });

  it("rejects repeated full used-by pages when the provider omits its total", async () => {
    let requestedPages: number[] = [];
    let observations = 0;
    let page = Array.from({ length: 50 }, (_, index) => ({ id: `email-${index}`, name: `Email ${index}` }));
    let { ctx } = context({
      getDesignerAsset: async () => ({ id: "email-1", templateId: "template-A" }),
      getDesignerAssetUsedBy: async (_kind, request) => {
        let pageIndex = request.pageIndex ?? 0;
        requestedPages.push(pageIndex);
        return { result: page, pageDetails: { currentPage: pageIndex + 1, pageSize: request.pageSize } };
      },
    }, [{ id: 1, type: "designerDelete", asset: "designerEmail", targetId: "email-1" }]);
    ctx.observe = async () => { observations++; };

    await expect(new MarketoDesignerEmailTemplateImpl(ctx, "template-A").getUsedBy())
      .rejects.toThrow(/overlapping used-by pages/);
    expect(requestedPages).toEqual([0, 1]);
    expect(observations).toBe(0);
  });

  it("rejects partially overlapping used-by pages without satisfying the reported total", async () => {
    let requestedPages: number[] = [];
    let observations = 0;
    let { ctx } = context({
      getDesignerAsset: async () => ({ id: "email-delete", templateId: "template-A" }),
      getDesignerAssetUsedBy: async (_kind, request) => {
        let pageIndex = request.pageIndex ?? 0;
        requestedPages.push(pageIndex);
        let start = pageIndex === 0 ? 1 : 50;
        return {
          result: Array.from({ length: 50 }, (_, index) => ({ id: pageIndex === 0 ? start + index : String(start + index) })),
          pageDetails: { totalItems: 100, currentPage: pageIndex + 1, pageSize: request.pageSize },
        };
      },
    }, [{ id: 1, type: "designerDelete", asset: "designerEmail", targetId: "email-delete" }]);
    ctx.observe = async () => { observations++; };

    await expect(new MarketoDesignerEmailTemplateImpl(ctx, "template-A").getUsedBy())
      .rejects.toThrow(/overlapping used-by pages/);
    expect(requestedPages).toEqual([0, 1]);
    expect(observations).toBe(0);
  });

  it("rejects a full used-by page with no dependency IDs as non-advancing", async () => {
    let requestedPages: number[] = [];
    let { ctx } = context({
      getDesignerAsset: async () => ({ id: "email-delete", templateId: "template-A" }),
      getDesignerAssetUsedBy: async (_kind, request) => {
        requestedPages.push(request.pageIndex ?? 0);
        return {
          result: Array.from({ length: 50 }, () => ({ name: "Missing ID" })),
          pageDetails: { currentPage: 1, pageSize: request.pageSize },
        };
      },
    }, [{ id: 1, type: "designerDelete", asset: "designerEmail", targetId: "email-delete" }]);

    await expect(new MarketoDesignerEmailTemplateImpl(ctx, "template-A").getUsedBy())
      .rejects.toThrow(/non-advancing used-by paging state/);
    expect(requestedPages).toEqual([0]);
  });

  it("merges a page without materializing an upstream collection over 1000 rows", async () => {
    let requestedPages: number[] = [];
    let { ctx } = context({
      filterDesignerAssets: async (_kind, options) => {
        let pageIndex = options.pageIndex ?? 0;
        let pageSize = options.pageSize ?? 50;
        requestedPages.push(pageIndex);
        let start = pageIndex * pageSize;
        return {
          items: Array.from({ length: Math.min(pageSize, 1_500 - start) }, (_, offset) => ({
            id: `email-${start + offset}`,
            name: `Email ${start + offset}`,
            status: "draft",
            appData: { workspaceId: "1" },
          })),
          totalItems: 1_500,
          currentPage: pageIndex,
          pageSize,
        };
      },
      getDesignerAsset: async () => ({
        id: "email-1200", name: "Email 1200", status: "draft", appData: { workspaceId: "1" },
      }),
    }, [{ id: 1, type: "designerDelete", asset: "designerEmail", targetId: "email-1200" }]);

    let result = await new MarketoEmailDesignerImpl(ctx).listEmails("1", { pageSize: 20 });

    expect(result).toMatchObject({ pageIndex: 0, pageSize: 20, totalItems: 1_499 });
    expect(result.items).toHaveLength(20);
    expect(requestedPages).toEqual([0]);
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

  it("rejects a template and content in the same email update without submitting an action", async () => {
    let { actions, ctx } = context({});
    let email = new MarketoDesignerEmailImpl(ctx, "email-1");

    await expect(email.update({
      templateId: "template-1",
      content: { html: "<p>Overwritten</p>" },
    })).rejects.toThrow(/templateId and content cannot be specified together.*overwrites email content/);
    expect(actions).toEqual([]);
  });

  it("rejects a template and content in the same email create without a pending row or action", async () => {
    let { actions, ctx } = context({
      filterDesignerAssets: async () => ({ items: [], totalItems: 0, currentPage: 0, pageSize: 50 }),
    });
    let designer = new MarketoEmailDesignerImpl(ctx);

    await expect(designer.createEmail({
      location: { workspaceId: "1", folderId: "10" },
      name: "Invalid email",
      headers: { subject: "Subject" },
      templateId: "template-1",
      content: { html: "<p>Overwritten</p>" },
    })).rejects.toThrow(/templateId and content cannot be specified together.*overwrites email content/);
    expect(actions).toEqual([]);
    expect((await designer.listEmails("1")).items).toEqual([]);
  });

  it("rejects empty content by its content contract before template conflict validation", async () => {
    let { actions, ctx } = context({});
    let emptyContent = {} as never;

    expect(() => new MarketoEmailDesignerImpl(ctx).createEmail({
      location: { workspaceId: "1", folderId: "10" },
      name: "Invalid email",
      headers: { subject: "Subject" },
      templateId: "template-1",
      content: emptyContent,
    })).toThrow(/expected union/);
    expect(() => new MarketoDesignerEmailImpl(ctx, "email-1").update({
      templateId: "template-1",
      content: emptyContent,
    })).toThrow(/expected union/);
    expect(actions).toEqual([]);
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
