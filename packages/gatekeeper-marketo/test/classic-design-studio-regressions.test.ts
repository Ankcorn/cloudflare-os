import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { MarketoClient } from "../src/marketo-api";
import {
  executeDesignStudioAction,
  type DesignStudioAction,
  type DesignStudioActionInput,
} from "../src/design-studio-actions";
import { MarketoDesignStudioImpl, type DesignStudioContext } from "../src/design-studio";
import type {
  MarketoDesignStudio,
  MarketoDesignStudioFileListOptions,
  MarketoDesignStudioListOptions,
  MarketoDesignStudioStatus,
} from "../src/types";

function context(client: Partial<MarketoClient>, initial: DesignStudioAction[] = []) {
  let actions = [...initial];
  let nextProvisional = 0;
  let ctx: DesignStudioContext = {
    client: async () => client as MarketoClient,
    observe: async () => {},
    submit: async () => {},
    dispose: () => {},
    retain: () => {},
    allocateProvisional: () => `~${++nextProvisional}`,
    logicalKind: id => actions.find((action): action is Extract<DesignStudioAction, { type: "designCreate" | "designClone" }> =>
      (action.type === "designCreate" || action.type === "designClone") && action.provisionalId === id
    )?.asset,
    pending: () => actions,
    resolveId: id => /^\d+$/.test(id) ? Number(id) : undefined,
    submitDesign: async (input: DesignStudioActionInput) => {
      actions.push({ ...input, id: actions.length + 1 } as DesignStudioAction);
    },
  };
  return { actions, ctx };
}

async function expectDeleted(operation: () => unknown): Promise<void> {
  await expect(Promise.resolve().then(operation)).rejects.toThrow(/was deleted/);
}

describe("classic Design Studio regressions", () => {
  it("includes current inherited metadata in pending clone list summaries", async () => {
    let source = {
      id: 21,
      name: "Source",
      description: "Original description",
      status: "approved",
      workspace: "Default",
      subject: { type: "Text", value: "Original subject" },
      fromName: { type: "Text", value: "Marketing" },
      fromEmail: { type: "Text", value: "marketing@example.com" },
      replyEmail: { type: "Text", value: "reply@example.com" },
      preHeader: "Preview",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    };
    let { ctx } = context({
      getEmails: async () => [],
      getEmail: async () => source,
      getFolder: async () => ({
        id: 10, name: "Destination", folderId: { id: 10, type: "Folder" }, workspace: "Destination workspace",
      }),
    });
    let studio = new MarketoDesignStudioImpl(ctx);
    await studio.getEmail("21").updateMetadata({
      description: "Pending description",
      subject: "Pending subject",
    });
    await studio.cloneEmail("21", "Clone", { id: "10", type: "folder" });

    expect((await studio.listEmails()).items.find(item => item.id === "~1")).toEqual(
      expect.objectContaining({
        id: "~1",
        name: "Clone",
        description: "Pending description",
        subject: "Pending subject",
        fromName: "Marketing",
        fromEmail: "marketing@example.com",
        replyEmail: "reply@example.com",
        preHeader: "Preview",
        workspaceName: "Destination workspace",
        status: "draft",
      }),
    );
    let clone = (await studio.listEmails()).items.find(item => item.id === "~1")!;
    expect(clone).not.toHaveProperty("createdAt");
    expect(clone).not.toHaveProperty("updatedAt");
  });

  it("omits dynamic email headers from descriptions", async () => {
    let { ctx } = context({
      getEmail: async () => ({
        id: 21,
        name: "Segmented email",
        status: "draft",
        subject: { type: "DynamicContent", value: "3898697798" },
        fromName: { type: "Text", value: "Marketing" },
      }),
    });

    let detail = await new MarketoDesignStudioImpl(ctx).getEmail("21").describe();

    expect(detail).toMatchObject({ id: "21", name: "Segmented email", fromName: "Marketing" });
    expect(detail).not.toHaveProperty("subject");
  });

  it("does not turn a described dynamic header into text during a metadata round trip", async () => {
    let { actions, ctx } = context({
      getEmail: async () => ({
        id: 21,
        name: "Segmented email",
        status: "draft",
        subject: { type: "DynamicContent", value: "3898697798" },
      }),
    });
    let email = new MarketoDesignStudioImpl(ctx).getEmail("21");
    let observed = await email.describe();

    await email.updateMetadata({ name: observed.name, subject: observed.subject });

    expect(actions).toEqual([expect.objectContaining({
      type: "designMetadata",
      patch: { name: "Segmented email" },
    })]);
    let updateEmail = vi.fn(async () => [{ id: 21 }]);
    let updateEmailContent = vi.fn();
    await executeDesignStudioAction(actions[0]!, {
      updateEmail,
      updateEmailContent,
    } as unknown as MarketoClient, Number, () => {});
    expect(updateEmail).toHaveBeenCalledWith(21, { name: "Segmented email" });
    expect(updateEmailContent).not.toHaveBeenCalled();
  });

  it("neither exposes nor rewrites non-static classic email regions", async () => {
    let { actions, ctx } = context({
      getEmailContent: async () => [
        { htmlId: "static", contentType: "Text", value: "Static" },
        { htmlId: "dynamic", contentType: "DynamicContent", value: "123" },
        { htmlId: "snippet", contentType: "Snippet", value: "456" },
        { htmlId: "module", contentType: "Module", value: [{ type: "Text", value: "Child" }] },
      ],
    });
    let email = new MarketoDesignStudioImpl(ctx).getEmail("21");

    expect((await email.getContent()).map(section => section.id)).toEqual(["static"]);
    for (let id of ["dynamic", "snippet", "module"]) {
      await expect(email.updateContent(id, { html: "replacement" }))
        .rejects.toThrow(/not editable static Text content/);
    }
    expect(actions).toEqual([]);
  });

  it("does not copy generated source identity into pending clone summaries", async () => {
    let { ctx } = context({
      getLandingPages: async () => [],
      getLandingPage: async () => ({
        id: 21,
        name: "Source",
        description: "Inherited",
        status: "approved",
        workspace: "Source workspace",
        computedUrl: "https://example.com/source",
      }),
      getFolder: async () => ({
        id: 10, name: "Destination", folderId: { id: 10, type: "Folder" }, workspace: "Destination workspace",
      }),
    });
    let studio = new MarketoDesignStudioImpl(ctx);

    let clone = await studio.cloneLandingPage("21", "Clone", { id: "10", type: "folder" });
    let detail = await clone.describe();
    let listed = (await studio.listLandingPages()).items[0]!;

    expect(detail).toMatchObject({
      id: "~1", name: "Clone", description: "Inherited", status: "draft",
      workspaceName: "Destination workspace",
    });
    expect(detail).not.toHaveProperty("url");
    expect(listed).not.toHaveProperty("url");
  });

  it("uses depth-aware folder browsing for exact-name queries", async () => {
    let getFolders = vi.fn(async () => [{
      id: 11,
      name: "Target",
      folderId: { id: 11, type: "Folder" },
      parent: { id: 10, type: "Folder" },
    }]);
    let getFoldersByName = vi.fn();
    let { ctx } = context({ getFolders, getFoldersByName });

    let result = await new MarketoDesignStudioImpl(ctx).listFolders({
      name: "Target",
      root: { id: "10", type: "folder" },
      maxDepth: 1,
    });

    expect(result.items.map(item => item.id)).toEqual(["11"]);
    expect(getFolders).toHaveBeenCalledWith({
      root: { id: 10, type: "Folder" },
      maxDepth: 2,
      workspace: undefined,
      offset: 0,
      maxReturn: 200,
    });
    expect(getFoldersByName).not.toHaveBeenCalled();
  });

  it("queries both folder result types independently of the root type", async () => {
    let getFoldersByName = vi.fn(async (_name: string, options: { type?: "Folder" | "Program" }) =>
      options.type === "Folder"
        ? [{ id: 11, name: "Target", folderId: { id: 11, type: "Folder" }, parent: { id: 10, type: "Program" } }]
        : [{ id: 12, name: "Target", folderId: { id: 12, type: "Program" }, parent: { id: 10, type: "Program" } }]);
    let { ctx } = context({ getFoldersByName });

    let result = await new MarketoDesignStudioImpl(ctx).listFolders({
      name: "Target",
      root: { id: "10", type: "program" },
    });

    expect(result.items.map(item => [item.id, item.type])).toEqual([["11", "folder"], ["12", "program"]]);
    expect(getFoldersByName.mock.calls.map(([, options]) => options)).toEqual([
      { type: "Folder", root: { id: 10, type: "Program" }, workspace: undefined },
      { type: "Program", root: { id: 10, type: "Program" }, workspace: undefined },
    ]);
  });

  it("excludes a rooted browse result before depth and page-size semantics", async () => {
    let records = [
      { id: 10, name: "Root", folderId: { id: 10, type: "Folder" } },
      { id: 11, name: "Child one", folderId: { id: 11, type: "Folder" }, parent: { id: 10, type: "Folder" } },
      { id: 12, name: "Child two", folderId: { id: 12, type: "Folder" }, parent: { id: 10, type: "Folder" } },
    ];
    let getFolders = vi.fn(async ({ offset = 0, maxReturn = 200 }: {
      offset?: number; maxReturn?: number; maxDepth?: number;
    }) =>
      records.slice(offset, offset + maxReturn));
    let { ctx } = context({ getFolders });
    let studio = new MarketoDesignStudioImpl(ctx);
    let options = { root: { id: "10", type: "folder" } as const, maxDepth: 20, maxResults: 1 };

    let first = await studio.listFolders(options);
    let second = await studio.listFolders({ ...options, pageToken: first.nextPageToken });

    expect(first.items.map(item => item.id)).toEqual(["11"]);
    expect(second.items.map(item => item.id)).toEqual(["12"]);
    expect(getFolders.mock.calls.map(([request]) => [request.offset, request.maxReturn, request.maxDepth]))
      .toEqual([[0, 1, 21], [1, 1, 21], [2, 1, 21]]);
  });

  it("round-trips Unicode list scopes through page tokens", async () => {
    let getEmailsByName = vi.fn(async () => [
      { id: 1, name: "Mañana 東京" },
      { id: 2, name: "Mañana 東京" },
    ]);
    let { ctx } = context({ getEmailsByName });
    let studio = new MarketoDesignStudioImpl(ctx);

    let first = await studio.listEmails({ name: "Mañana 東京", maxResults: 1 });
    let second = await studio.listEmails({
      name: "Mañana 東京",
      maxResults: 1,
      pageToken: first.nextPageToken,
    });

    expect(first.items.map(item => item.id)).toEqual(["1"]);
    expect(second.items.map(item => item.id)).toEqual(["2"]);
  });

  it("browses status-specific landing-page-template versions and filters names locally", async () => {
    let records = [
      { id: 1, name: "Other", status: "approved" },
      { id: 2, name: "Target", status: "approved" },
    ];
    let getLandingPageTemplates = vi.fn(async ({ offset = 0, maxReturn = 200 }: {
      offset?: number; maxReturn?: number;
    }) => records.slice(offset, offset + maxReturn));
    let getLandingPageTemplatesByName = vi.fn();
    let { ctx } = context({ getLandingPageTemplates, getLandingPageTemplatesByName });
    let studio = new MarketoDesignStudioImpl(ctx);
    let options = { name: "Target", status: "approved" as const, maxResults: 1 };

    let first = await studio.listLandingPageTemplates(options);
    let second = await studio.listLandingPageTemplates({ ...options, pageToken: first.nextPageToken });

    expect(first.items).toEqual([]);
    expect(second.items.map(item => item.id)).toEqual(["2"]);
    expect(getLandingPageTemplates.mock.calls.map(([request]) => request)).toEqual([
      { status: "approved", folder: undefined, offset: 0, maxReturn: 1 },
      { status: "approved", folder: undefined, offset: 1, maxReturn: 1 },
    ]);
    expect(getLandingPageTemplatesByName).not.toHaveBeenCalled();
  });

  it("rejects program parents for email-template create/clone and file create before submission", async () => {
    let { actions, ctx } = context({});
    let studio = new MarketoDesignStudioImpl(ctx);
    let destination = { id: "10", type: "program" } as const;

    await expect(studio.createEmailTemplate(destination, { name: "Template", content: "x" }))
      .rejects.toThrow(/ordinary folder/);
    await expect(studio.cloneEmailTemplate("20", "Clone", destination))
      .rejects.toThrow(/ordinary folder/);
    await expect(studio.createFile(destination, {
      name: "logo.png", mimeType: "image/png", data: new Uint8Array([1]),
    })).rejects.toThrow(/ordinary folder/);
    expect(actions).toEqual([]);
  });

  it("revalidates restricted classic asset parents in the executor", async () => {
    let createFile = vi.fn();
    await expect(executeDesignStudioAction({
      id: 1, type: "designCreate", asset: "file", provisionalId: "~1",
      parent: { id: "10", type: "Program" },
      input: { name: "logo.png", mimeType: "image/png", data: new Uint8Array([1]) },
    }, { createFile } as unknown as MarketoClient, Number, () => {})).rejects.toThrow(/ordinary folder/);
    expect(createFile).not.toHaveBeenCalled();
  });

  it("still rejects a genuinely mismatched MIME type after file creation", async () => {
    await expect(executeDesignStudioAction({
      id: 1,
      type: "designCreate",
      asset: "file",
      provisionalId: "~1",
      parent: { id: "10", type: "Folder" },
      input: {
        name: "note.txt",
        mimeType: "text/plain",
        data: new Uint8Array([1]),
      },
    }, {
      createFile: async () => [{ id: 20 }],
      getFile: async () => ({
        id: 20,
        name: "note.txt",
        mimeType: "application/octet-stream",
        folder: { id: 10, type: "Folder" },
      }),
    } as unknown as MarketoClient, Number, () => {})).rejects.toThrow(/could not verify created file/);
  });

  it("accepts Adobe's uppercase folder discriminator without weakening identity checks", async () => {
    let action = {
      id: 1,
      type: "designCreate",
      asset: "folder",
      provisionalId: "~1",
      parent: { id: "10", type: "Folder" },
      input: { name: "Child" },
    } as const;
    let verify = (created: { id: number; name: string; parent: { id: number; type: string } }) =>
      executeDesignStudioAction(action, {
        createFolder: async () => [{ id: 20 }],
        getFolder: async () => created,
      } as unknown as MarketoClient, Number, () => {});

    await expect(verify({ id: 20, name: "Child", parent: { id: 10, type: "FOLDER" } }))
      .resolves.toBeUndefined();
    await expect(verify({ id: 20, name: "Other", parent: { id: 10, type: "FOLDER" } }))
      .rejects.toThrow(/could not verify created folder/);
    await expect(verify({ id: 20, name: "Child", parent: { id: 11, type: "FOLDER" } }))
      .rejects.toThrow(/could not verify created folder/);
    await expect(verify({ id: 20, name: "Child", parent: { id: 10, type: "PROGRAM" } }))
      .rejects.toThrow(/could not verify created folder/);
  });

  it("rejects file status filters in the API type and at runtime", () => {
    expectTypeOf<Parameters<MarketoDesignStudio["listFiles"]>[0]>()
      .toEqualTypeOf<MarketoDesignStudioFileListOptions | undefined>();
    let { ctx } = context({ getFiles: vi.fn() });
    let studio = new MarketoDesignStudioImpl(ctx);

    expect(() => studio.listFiles({ status: "approved" } as never))
      .toThrow(/status is not supported/);
  });

  it("exposes only supported list statuses while preserving provider summary statuses", () => {
    expectTypeOf<MarketoDesignStudioListOptions["status"]>()
      .toEqualTypeOf<"draft" | "approved" | undefined>();
    expectTypeOf<"provider-specific">().toExtend<MarketoDesignStudioStatus>();
  });

  it("normalizes file update MIME before approval, simulation, and dispatch", async () => {
    let updateFileContent = vi.fn(async (_id: number, _file: Blob, _name: string) => [{ id: 20 }]);
    let client = {
      getFile: async () => ({ id: 20, name: "note.txt", mimeType: "text/plain" }),
      updateFileContent,
    };
    let { actions, ctx } = context(client);
    let file = new MarketoDesignStudioImpl(ctx).getFile("20");

    await file.updateContent(new Uint8Array([1]), "TEXT/PLAIN");

    expect(actions[0]).toMatchObject({ type: "designContent", mimeType: "text/plain" });
    await expect(file.describe()).resolves.toMatchObject({ mimeType: "text/plain" });
    await executeDesignStudioAction(actions[0]!, client as unknown as MarketoClient, Number, () => {});
    expect((updateFileContent.mock.calls[0]![1] as Blob).type).toBe("text/plain");
  });

  it("correlates folder listings with the requested workspace", async () => {
    let { ctx } = context({
      getFolders: async () => [
        { id: 10, name: "Right", folderId: { id: 10, type: "Folder" }, workspace: "Default" },
        { id: 11, name: "Wrong", folderId: { id: 11, type: "Folder" }, workspace: "Other" },
        { id: 12, name: "Missing", folderId: { id: 12, type: "Folder" } },
      ],
    });

    let result = await new MarketoDesignStudioImpl(ctx).listFolders({ workspace: "Default" });

    expect(result.items.map(item => item.id)).toEqual(["10"]);
  });

  it("correlates folder-scoped asset rows with parent id and discriminator", async () => {
    let records = [
      { id: 1, name: "Right", folder: { id: 10, type: "Folder" } },
      { id: 2, name: "Wrong type", folder: { id: 10, type: "Program" } },
      { id: 3, name: "Missing type", folder: { id: 10 } },
      { id: 4, name: "Wrong id", folder: { id: 11, type: "Folder" } },
    ];
    let { ctx } = context({ getEmails: async () => records });

    let result = await new MarketoDesignStudioImpl(ctx).listEmails({
      folder: { id: "10", type: "folder" },
    });

    expect(result.items.map(item => item.id)).toEqual(["1"]);
  });

  it("does not queue or dispatch an empty snippet content update", async () => {
    let { actions, ctx } = context({});
    let snippet = new MarketoDesignStudioImpl(ctx).getSnippet("40");

    expect(() => snippet.updateContent({})).toThrow(/At least one snippet rendition is required/);
    expect(actions).toEqual([]);
    await expect(executeDesignStudioAction({
      id: 1,
      type: "designContent",
      asset: "snippet",
      targetId: "40",
    }, {} as MarketoClient, Number, () => {})).rejects.toThrow(/Missing snippet content rendition/);
  });

  it("derives the workspace of nested pending folders from their parent", async () => {
    let getFolder = vi.fn(async () => ({
      id: 10,
      name: "Parent",
      folderId: { id: 10, type: "Folder" },
      workspace: "Default",
    }));
    let { ctx } = context({ getFolders: async () => [], getFolder }, [
      {
        id: 1,
        type: "designCreate",
        asset: "folder",
        provisionalId: "~1",
        parent: { id: "10", type: "Folder" },
        input: { name: "Child" },
      },
      {
        id: 2,
        type: "designCreate",
        asset: "folder",
        provisionalId: "~2",
        parent: { id: "~1", type: "Folder" },
        input: { name: "Grandchild" },
      },
    ]);

    let result = await new MarketoDesignStudioImpl(ctx).listFolders({ workspace: "Default" });

    expect(result.items).toEqual([
      expect.objectContaining({ id: "~1", workspaceName: "Default" }),
      expect.objectContaining({ id: "~2", workspaceName: "Default" }),
    ]);
    expect(getFolder).toHaveBeenCalledTimes(1);
  });

  it("blocks every post-delete asset operation before provider or approval access", async () => {
    let deleted: DesignStudioAction[] = [
      { id: 1, type: "designDeleteFolder", targetId: "1" },
      ...(["email", "emailTemplate", "landingPage", "landingPageTemplate", "form", "snippet"] as const)
        .map((asset, index): DesignStudioAction => ({
          id: index + 2,
          type: "designLifecycle",
          asset,
          targetId: String(index + 2),
          operation: "delete",
        })),
    ];
    let { ctx } = context({}, deleted);
    let provider = vi.fn(async () => ({} as MarketoClient));
    let submit = vi.fn();
    ctx.client = provider;
    ctx.submitDesign = submit;
    let studio = new MarketoDesignStudioImpl(ctx);
    let folder = studio.getFolder("1", "folder");
    let email = studio.getEmail("2");
    let emailTemplate = studio.getEmailTemplate("3");
    let landingPage = studio.getLandingPage("4");
    let landingPageTemplate = studio.getLandingPageTemplate("5");
    let form = studio.getForm("6");
    let snippet = studio.getSnippet("7");
    for (let operation of [
      () => folder.describe(), () => folder.updateMetadata({ name: "No" }), () => folder.delete(),
      () => email.describe(), () => email.getContent(), () => email.updateMetadata({ name: "No" }),
      () => email.updateContent("main", { html: "No" }), () => email.approve(), () => email.unapprove(),
      () => email.discardDraft(), () => email.delete(),
      () => emailTemplate.describe(), () => emailTemplate.getContent(),
      () => emailTemplate.updateMetadata({ name: "No" }), () => emailTemplate.updateContent("No"),
      () => emailTemplate.approve(), () => emailTemplate.unapprove(), () => emailTemplate.discardDraft(),
      () => emailTemplate.delete(),
      () => landingPage.describe(), () => landingPage.getContent(),
      () => landingPage.updateMetadata({ name: "No" }), () => landingPage.approve(),
      () => landingPage.unapprove(), () => landingPage.discardDraft(), () => landingPage.delete(),
      () => landingPageTemplate.describe(), () => landingPageTemplate.getContent(),
      () => landingPageTemplate.updateMetadata({ name: "No" }), () => landingPageTemplate.updateContent("No"),
      () => landingPageTemplate.approve(), () => landingPageTemplate.unapprove(),
      () => landingPageTemplate.discardDraft(), () => landingPageTemplate.delete(),
      () => form.describe(), () => form.getFields(), () => form.updateMetadata({ name: "No" }),
      () => form.approve(), () => form.discardDraft(), () => form.delete(),
      () => snippet.describe(), () => snippet.getContent(), () => snippet.updateMetadata({ name: "No" }),
      () => snippet.updateContent({ html: "No" }), () => snippet.approve(), () => snippet.unapprove(),
      () => snippet.discardDraft(), () => snippet.delete(),
    ]) await expectDeleted(operation);

    expect(provider).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("guards deleted asset dependencies, but allows work after rejection", async () => {
    let initial: DesignStudioAction[] = [
      { id: 1, type: "designLifecycle", asset: "email", targetId: "10", operation: "delete" },
      { id: 2, type: "designLifecycle", asset: "emailTemplate", targetId: "11", operation: "delete" },
      { id: 3, type: "designDeleteFolder", targetId: "12" },
    ];
    let { actions, ctx } = context({}, initial);
    let provider = vi.fn(async () => ({} as MarketoClient));
    let submit = vi.fn();
    ctx.client = provider;
    ctx.submitDesign = submit;
    let studio = new MarketoDesignStudioImpl(ctx);

    await expect(studio.cloneEmail("10", "Clone", { id: "20", type: "folder" }))
      .rejects.toThrow(/was deleted/);
    await expect(studio.createEmail({ id: "20", type: "folder" }, {
      name: "Email", templateId: "11", subject: "S", fromName: "F",
      fromEmail: "from@example.com", replyEmail: "reply@example.com",
    })).rejects.toThrow(/was deleted/);
    await expect(studio.createSnippet({ id: "12", type: "folder" }, { name: "Snippet" }))
      .rejects.toThrow(/was deleted/);
    expect(provider).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();

    actions.splice(0);
    await studio.getEmail("10").updateMetadata({ name: "Allowed" });
    expect(submit).toHaveBeenCalledOnce();
  });

  it("validates approve and unapprove against the overlaid lifecycle state", async () => {
    let { actions, ctx } = context({
      getEmailTemplate: async () => ({ id: 31, name: "Template", status: "draft" }),
      getEmailTemplateContent: async () => ({ id: 31, content: "<p>Draft</p>" }),
    });
    let template = new MarketoDesignStudioImpl(ctx).getEmailTemplate("31");

    await template.approve();
    await expect(template.approve()).rejects.toThrow(/no draft to approve/);
    await template.unapprove();
    await expect(template.unapprove()).rejects.toThrow(/not approved/);

    expect(actions.map(action => action.type === "designLifecycle" && action.operation))
      .toEqual(["approve", "unapprove"]);
    expect(actions[0]).toMatchObject({
      snapshot: {
        metadata: { name: "Template" },
        content: "<p>Draft</p>",
        affectedDependents: [],
      },
    });
  });

  it("snapshots complete classic email publishable state", async () => {
    let { actions, ctx } = context({
      getEmail: async () => ({
        id: 21,
        name: "Launch",
        status: "draft",
        subject: { type: "Text", value: "Exact subject" },
        fromName: { type: "Text", value: "Marketing" },
        fromEmail: { type: "Text", value: "marketing@example.com" },
        replyEmail: { type: "Text", value: "reply@example.com" },
        operational: true,
        isOpenTrackingDisabled: false,
        textOnly: false,
      }),
      getEmailContent: async () => [{
        htmlId: "main",
        value: [
          { type: "HTML", value: "<h1>Exact draft</h1>" },
          { type: "Text", value: "Exact draft" },
        ],
      }],
    });

    await new MarketoDesignStudioImpl(ctx).getEmail("21").approve();

    expect(actions[0]).toMatchObject({
      snapshot: {
        metadata: {
          subject: "Exact subject",
          fromEmail: "marketing@example.com",
          settings: { operational: true, isOpenTrackingDisabled: false, textOnly: false },
        },
        content: [{ id: "main", html: "<h1>Exact draft</h1>", text: "Exact draft" }],
        affectedDependents: [],
      },
    });
  });
});
