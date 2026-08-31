import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { MarketoClient } from "../src/marketo-api";
import {
  executeDesignStudioAction,
  type DesignStudioAction,
  type DesignStudioActionInput,
} from "../src/design-studio-actions";
import { MarketoDesignStudioImpl, type DesignStudioContext } from "../src/design-studio";
import type { MarketoDesignStudio, MarketoDesignStudioFileListOptions } from "../src/types";

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

describe("classic Design Studio regressions", () => {
  it("includes current inherited metadata in pending clone list summaries", async () => {
    let source = {
      id: 21,
      name: "Source",
      description: "Original description",
      status: "approved",
      workspace: "Default",
      subject: { value: "Original subject" },
      fromName: { value: "Marketing" },
      fromEmail: { value: "marketing@example.com" },
      replyEmail: { value: "reply@example.com" },
      preHeader: "Preview",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    };
    let { ctx } = context({ getEmails: async () => [], getEmail: async () => source });
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
        workspaceName: "Default",
        status: "draft",
        createdAt: undefined,
        updatedAt: undefined,
      }),
    );
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

  it("verifies a created file by parent id without treating its category as the parent type", async () => {
    let recordCreation = vi.fn();
    await executeDesignStudioAction({
      id: 1,
      type: "designCreate",
      asset: "file",
      provisionalId: "~1",
      parent: { id: "10", type: "Program" },
      input: {
        name: "logo.png",
        mimeType: "image/png",
        data: new Uint8Array([1]),
      },
    }, {
      createFile: async () => [{ id: 20 }],
      getFile: async () => ({
        id: 20,
        name: "logo.png",
        mimeType: "image/png",
        folder: { id: 10, type: "Images" },
      }),
    } as unknown as MarketoClient, Number, recordCreation);

    expect(recordCreation).toHaveBeenCalledWith("~1", 20);
  });

  it("rejects file status filters in the API type and at runtime", () => {
    expectTypeOf<Parameters<MarketoDesignStudio["listFiles"]>[0]>()
      .toEqualTypeOf<MarketoDesignStudioFileListOptions | undefined>();
    let { ctx } = context({ getFiles: vi.fn() });
    let studio = new MarketoDesignStudioImpl(ctx);

    expect(() => studio.listFiles({ status: "approved" } as never))
      .toThrow(/status is not supported/);
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
});
