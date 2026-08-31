import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { markdownCodeBlock, markdownJsonCodeBlock, markdownText } from "./approval-markdown";
import {
  MarketoResponseValidationError,
  type MarketoClient,
  type MarketoFolderRef,
  type RawAssetId,
  type RawDesignStudioAsset,
  type RawFile,
  type RawFolder,
} from "./marketo-api";

export type DesignStudioAssetKind =
  | "folder"
  | "email"
  | "emailTemplate"
  | "landingPage"
  | "landingPageTemplate"
  | "form"
  | "snippet"
  | "file";

export type DesignStudioMetadata = Record<string, string | undefined>;

export type DesignStudioCreateInput = {
  name: string;
  description?: string;
  subject?: string;
  fromName?: string;
  fromEmail?: string;
  replyEmail?: string;
  locale?: string;
  language?: string;
  content?: string;
  html?: string;
  text?: string;
  templateId?: string;
  data?: Uint8Array;
  mimeType?: string;
  sha256?: string;
  templateType?: "guided" | "freeForm";
  enableMunchkin?: boolean;
};

type DesignStudioCloneAction = {
  id: number;
  type: "designClone";
  provisionalId: string;
  sourceId: string;
  parent: { id: string; type: "Folder" | "Program" };
  name: string;
  asset: Exclude<DesignStudioAssetKind, "folder" | "file">;
};

export type DesignStudioAction =
  | {
      id: number;
      type: "designCreate";
      asset: DesignStudioAssetKind;
      provisionalId: string;
      parent: { id: string; type: "Folder" | "Program" };
      input: DesignStudioCreateInput;
    }
  | DesignStudioCloneAction
  | {
      id: number;
      type: "designMetadata";
      asset: DesignStudioAssetKind;
      targetId: string;
      patch: DesignStudioMetadata;
    }
  | {
      id: number;
      type: "designContent";
      asset: "email" | "emailTemplate" | "landingPageTemplate" | "snippet" | "file";
      targetId: string;
      sectionId?: string;
      content?: string;
      html?: string;
      text?: string;
      data?: Uint8Array;
      mimeType?: string;
      sha256?: string;
      fileName?: string;
    }
  | {
      id: number;
      type: "designLifecycle";
      asset: Exclude<DesignStudioAssetKind, "folder" | "file">;
      targetId: string;
      operation: "approve" | "unapprove" | "discardDraft" | "delete";
    }
  | { id: number; type: "designDeleteFolder"; targetId: string };

export type DesignStudioActionInput = DesignStudioAction extends infer T
  ? T extends DesignStudioAction
    ? Omit<T, "id">
    : never
  : never;

export function isDesignStudioAction(action: { type: string }): action is DesignStudioAction {
  return action.type.startsWith("design") && !action.type.startsWith("designer");
}

function label(kind: DesignStudioAssetKind): string {
  return kind.replace(/[A-Z]/g, letter => ` ${letter.toLowerCase()}`);
}

function codeBlock(value: unknown): string {
  return typeof value === "string" ? markdownCodeBlock(value) : markdownJsonCodeBlock(value);
}

function details(values: Record<string, unknown>): string {
  return Object.entries(values).filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${markdownText(key)}:\n\n${codeBlock(value)}`).join("\n\n");
}

function createDetails(input: DesignStudioCreateInput): string {
  let { data, ...visible } = input;
  return details(data ? {
    name: input.name,
    mimeType: input.mimeType,
    byteCount: data.byteLength,
    sha256: input.sha256,
    description: input.description,
  } : visible);
}

export function describeDesignStudioAction(action: DesignStudioAction): ActionDescription {
  let target = "targetId" in action ? action.targetId : undefined;
  let base = { implementsRevert: false } as const;
  switch (action.type) {
    case "designCreate":
      return {
        ...base,
        // Marketo generates the editable regions/default fields for these assets. Their metadata
        // is simulated, but callers should not continue into content reads until that shape exists.
        awaitDecision: action.asset === "email" || action.asset === "landingPage" || action.asset === "form",
        title: `Create Marketo ${label(action.asset)}`,
        description:
          `Create a Marketo ${label(action.asset)} in ${action.parent.type.toLowerCase()}:\n\n` +
          `${codeBlock(action.parent.id)}\n\nwith these values:\n\n${createDetails(action.input)}`,
      };
    case "designClone":
      return {
        ...base,
        awaitDecision: false,
        title: `Clone Marketo ${label(action.asset)}`,
        description:
          `Clone Marketo ${label(action.asset)}:\n\n${codeBlock(action.sourceId)}\n\nas:\n\n` +
          `${codeBlock(action.name)}\n\nin ${action.parent.type.toLowerCase()}:\n\n${codeBlock(action.parent.id)}. ` +
          "The clone uses the source asset's current contents when it is dispatched.",
      };
    case "designMetadata":
      return {
        ...base,
        awaitDecision: false,
        title: `Update Marketo ${label(action.asset)} ${target ?? ""}`,
        description: `Update Design Studio metadata on:\n\n${codeBlock(target)}\n\n${details(action.patch)}`,
      };
    case "designContent":
      return {
        ...base,
        awaitDecision: false,
        title: `Update Marketo ${label(action.asset)} content`,
        description:
          `Replace static content on Design Studio asset:\n\n${codeBlock(target)}\n\n${details({
            sectionId: action.sectionId,
            content: action.content,
            html: action.html,
            text: action.text,
            mimeType: action.mimeType,
            name: action.fileName,
            byteLength: action.data?.byteLength,
            sha256: action.sha256,
          })}`,
      };
    case "designLifecycle":
      return {
        ...base,
        // Discarding a draft exposes approved content that cannot be reconstructed locally.
        awaitDecision: action.operation === "discardDraft",
        title: `${action.operation} Marketo ${label(action.asset)} ${target ?? ""}`,
        description: action.operation === "delete"
          ? `Permanently delete Design Studio ${label(action.asset)}:\n\n${codeBlock(target)}`
          : `${action.operation} Design Studio ${label(action.asset)}:\n\n${codeBlock(target)}`,
      };
    case "designDeleteFolder":
      return {
        ...base,
        awaitDecision: false,
        title: `Delete Marketo folder ${target ?? ""}`,
        description: `Permanently delete empty Design Studio folder:\n\n${codeBlock(target)}`,
      };
  }
}

type ResolveId = (id: string) => number;
type RecordCreation = (provisionalId: string, realId: number) => void;

function resultId(result: (RawDesignStudioAsset | RawFolder | RawFile | RawAssetId)[]): number {
  let id = result[0]?.id;
  if (result.length !== 1 || !Number.isSafeInteger(id) || Number(id) <= 0) {
    throw new MarketoResponseValidationError(
      "Marketo created the asset but did not return exactly one positive numeric id.",
    );
  }
  return Number(id);
}

function assertTargetResult(result: RawAssetId[], targetId: number, operation: string): void {
  let returnedId = result[0]?.id;
  if (result.length !== 1 || targetId <= 0 || !Number.isSafeInteger(returnedId) || returnedId !== targetId) {
    throw new Error(`Marketo returned an invalid result for ${operation} on asset ${targetId}.`);
  }
}

function folderRef(parent: { id: string; type: "Folder" | "Program" }, resolve: ResolveId): MarketoFolderRef {
  return { id: resolve(parent.id), type: parent.type };
}

async function verifyCreatedAsset(
  client: MarketoClient,
  asset: DesignStudioAssetKind,
  id: number,
  input: DesignStudioCreateInput,
  parent: MarketoFolderRef,
  templateId?: number,
): Promise<void> {
  let created = asset === "folder" ? await client.getFolder(id)
    : asset === "email" ? await client.getEmail(id)
      : asset === "emailTemplate" ? await client.getEmailTemplate(id)
        : asset === "landingPage" ? await client.getLandingPage(id)
          : asset === "landingPageTemplate" ? await client.getLandingPageTemplate(id)
            : asset === "form" ? await client.getForm(id)
              : asset === "snippet" ? await client.getSnippet(id)
                : await client.getFile(id);
  let folder = asset === "folder"
    ? (created as RawFolder | undefined)?.parent
    : (created as RawDesignStudioAsset | RawFile | undefined)?.folder;
  let folderId = folder?.id ?? folder?.value;
  let actual = created as Record<string, unknown> | undefined;
  let expected: Record<string, unknown> = { description: input.description };
  if (asset === "email" || asset === "landingPage") {
    expected.template = templateId;
  }
  if (asset === "email") {
    for (let field of ["subject", "fromName", "fromEmail", "replyEmail"] as const) {
      if (input[field] === undefined) continue;
      let headerValue = actual?.[field];
      if (actual) {
        actual[field] = (Array.isArray(headerValue) ? headerValue : [headerValue])
          .map(part => part && typeof part === "object" ? Reflect.get(part, "value") : undefined)
          .join("");
      }
      expected[field] = input[field];
    }
  }
  if (asset === "landingPageTemplate") {
    expected.templateType = input.templateType;
    expected.enableMunchkin = input.enableMunchkin;
  }
  if (asset === "form") { expected.locale = input.locale; expected.language = input.language; }
  if (asset === "file") expected.mimeType = input.mimeType;
  if (!created || created.id !== id || created.name !== input.name || folderId !== parent.id ||
      (asset !== "file" && folder?.type?.toLowerCase() !== parent.type.toLowerCase()) ||
      Object.entries(expected).some(([key, value]) => value !== undefined && actual?.[key] !== value)) {
    throw new Error(`Marketo could not verify created ${asset} ${id} against the approved request.`);
  }
}

/** Execute one approved Design Studio action. The caller records dispatch before invoking this. */
export async function executeDesignStudioAction(
  action: DesignStudioAction,
  client: MarketoClient,
  resolve: ResolveId,
  recordCreation: RecordCreation,
  recordCandidate: (realId: number) => void = () => {},
  landingPageTemplateId?: number,
): Promise<void> {
  if (action.type === "designCreate") {
    if ((action.asset === "emailTemplate" || action.asset === "file") && action.parent.type !== "Folder") {
      throw new Error(`Marketo ${action.asset === "file" ? "file" : "email-template"} destination must be an ordinary folder.`);
    }
    let folder = folderRef(action.parent, resolve);
    let input = action.input;
    let templateId: number | undefined;
    let created: (RawDesignStudioAsset | RawFolder | RawFile)[];
    switch (action.asset) {
      case "folder":
        created = await client.createFolder({ name: input.name, parent: folder, description: input.description });
        break;
      case "email":
        templateId = resolve(required(input.templateId, "email template"));
        created = await client.createEmail({
          name: input.name,
          folder,
          template: templateId,
          description: input.description,
          subject: input.subject,
          fromName: input.fromName,
          fromEmail: input.fromEmail,
          replyEmail: input.replyEmail,
        });
        break;
      case "emailTemplate":
        created = await client.createEmailTemplate({
          name: input.name,
          folder,
          content: required(input.content, "template content"),
          description: input.description,
        });
        break;
      case "landingPage":
        templateId = resolve(required(input.templateId, "landing-page template"));
        created = await client.createLandingPage({
          name: input.name,
          folder,
          template: templateId,
          description: input.description,
        });
        break;
      case "landingPageTemplate":
        created = await client.createLandingPageTemplate({
          name: input.name,
          folder,
          description: input.description,
          templateType: input.templateType,
          enableMunchkin: input.enableMunchkin,
        });
        break;
      case "form":
        created = await client.createForm({
          name: input.name,
          folder,
          description: input.description,
          locale: input.locale,
          language: input.language,
        });
        break;
      case "snippet":
        created = await client.createSnippet({ name: input.name, folder, description: input.description });
        break;
      case "file": {
        let bytes = required(input.data, "file bytes");
        let mimeType = required(input.mimeType, "file MIME type");
        created = await client.createFile({
          name: input.name,
          folder,
          description: input.description,
          file: new Blob([bytes], { type: mimeType }),
          insertOnly: true,
        });
        break;
      }
    }
    let id = resultId(created);
    recordCandidate(id);
    await verifyCreatedAsset(client, action.asset, id, input, folder, templateId);
    recordCreation(action.provisionalId, id);
    if (action.asset === "snippet") {
      if (input.html !== undefined) assertTargetResult(await client.updateSnippetContent(id, "HTML", input.html), id, "snippet HTML update");
      if (input.text !== undefined) assertTargetResult(await client.updateSnippetContent(id, "Text", input.text), id, "snippet text update");
    }
    return;
  }

  if (action.type === "designClone") {
    if (action.asset === "emailTemplate" && action.parent.type !== "Folder") {
      throw new Error("Marketo email-template destination must be an ordinary folder.");
    }
    let id = resolve(action.sourceId);
    let clone = { name: action.name, folder: folderRef(action.parent, resolve) };
    let created;
    switch (action.asset) {
      case "email": created = await client.cloneEmail(id, clone); break;
      case "emailTemplate": created = await client.cloneEmailTemplate(id, clone); break;
      case "landingPage": created = await client.cloneLandingPage(id, {
        ...clone,
        template: required(landingPageTemplateId, "landing-page source template"),
      }); break;
      case "landingPageTemplate": created = await client.cloneLandingPageTemplate(id, clone); break;
      case "form": created = await client.cloneForm(id, clone); break;
      case "snippet": created = await client.cloneSnippet(id, clone); break;
    }
    let createdId = resultId(created);
    recordCandidate(createdId);
    await verifyCreatedAsset(client, action.asset, createdId, {
      name: action.name,
    }, clone.folder, landingPageTemplateId);
    recordCreation(action.provisionalId, createdId);
    return;
  }

  let id = resolve(action.targetId);
  if (action.type === "designDeleteFolder") {
    assertTargetResult(await client.deleteFolder(id), id, "folder delete");
    return;
  }
  if (action.type === "designMetadata") {
    switch (action.asset) {
      case "folder": assertTargetResult(await client.updateFolder(id, action.patch), id, "folder update"); return;
      case "email": {
        let { subject, fromName, fromEmail, replyEmail, ...metadata } = action.patch;
        if (Object.values(metadata).some(value => value !== undefined)) assertTargetResult(await client.updateEmail(id, metadata), id, "email metadata update");
        if ([subject, fromName, fromEmail, replyEmail].some(value => value !== undefined)) {
          assertTargetResult(await client.updateEmailContent(id, {
            subject: header(subject), fromName: header(fromName), fromEmail: header(fromEmail), replyEmail: header(replyEmail),
          }), id, "email header update");
        }
        return;
      }
      case "emailTemplate": assertTargetResult(await client.updateEmailTemplate(id, action.patch), id, "email-template update"); return;
      case "landingPage": assertTargetResult(await client.updateLandingPage(id, action.patch), id, "landing-page update"); return;
      case "landingPageTemplate": assertTargetResult(await client.updateLandingPageTemplate(id, action.patch), id, "landing-page-template update"); return;
      case "form": assertTargetResult(await client.updateForm(id, action.patch), id, "form update"); return;
      case "snippet": assertTargetResult(await client.updateSnippet(id, action.patch), id, "snippet update"); return;
      case "file": throw new Error("Marketo does not support updating file metadata.");
    }
  }
  if (action.type === "designContent") {
    switch (action.asset) {
      case "email":
        assertTargetResult(await client.updateEmailContentSection(id, required(action.sectionId, "section id"), {
          type: "Text", value: required(action.html, "HTML content"), textValue: action.text,
        }), id, "email section update");
        return;
      case "emailTemplate": assertTargetResult(await client.updateEmailTemplateContent(id, required(action.content, "content")), id, "email-template content update"); return;
      case "landingPageTemplate": assertTargetResult(await client.updateLandingPageTemplateContent(id, required(action.content, "content")), id, "landing-page-template content update"); return;
      case "snippet":
        if (action.html === undefined && action.text === undefined) {
          throw new Error("Missing snippet content rendition.");
        }
        if (action.html !== undefined) assertTargetResult(await client.updateSnippetContent(id, "HTML", action.html), id, "snippet HTML update");
        if (action.text !== undefined) assertTargetResult(await client.updateSnippetContent(id, "Text", action.text), id, "snippet text update");
        return;
      case "file": {
        let bytes = required(action.data, "file bytes");
        let mimeType = required(action.mimeType, "file MIME type");
        assertTargetResult(await client.updateFileContent(id, new Blob([bytes], { type: mimeType }), required(action.fileName, "file name")), id, "file content update");
        return;
      }
    }
  }
  let operation = action.operation;
  let run = async (approve: (id: number) => Promise<RawAssetId[]>, unapprove: (id: number) => Promise<RawAssetId[]>, discard: (id: number) => Promise<RawAssetId[]>, remove: (id: number) => Promise<RawAssetId[]>) => {
    let result = await (operation === "approve" ? approve(id) : operation === "unapprove" ? unapprove(id) : operation === "discardDraft" ? discard(id) : remove(id));
    assertTargetResult(result, id, `${action.asset} ${operation}`);
  };
  switch (action.asset) {
    case "email": await run(client.approveEmail.bind(client), client.unapproveEmail.bind(client), client.discardEmailDraft.bind(client), client.deleteEmail.bind(client)); return;
    case "emailTemplate": await run(client.approveEmailTemplate.bind(client), client.unapproveEmailTemplate.bind(client), client.discardEmailTemplateDraft.bind(client), client.deleteEmailTemplate.bind(client)); return;
    case "landingPage": await run(client.approveLandingPage.bind(client), client.unapproveLandingPage.bind(client), client.discardLandingPageDraft.bind(client), client.deleteLandingPage.bind(client)); return;
    case "landingPageTemplate": await run(client.approveLandingPageTemplate.bind(client), client.unapproveLandingPageTemplate.bind(client), client.discardLandingPageTemplateDraft.bind(client), client.deleteLandingPageTemplate.bind(client)); return;
    case "form":
      if (operation === "unapprove") throw new Error("Marketo forms do not support unapprove.");
      assertTargetResult(await (operation === "approve" ? client.approveForm(id) : operation === "discardDraft" ? client.discardFormDraft(id) : client.deleteForm(id)), id, `form ${operation}`);
      return;
    case "snippet": await run(client.approveSnippet.bind(client), client.unapproveSnippet.bind(client), client.discardSnippetDraft.bind(client), client.deleteSnippet.bind(client)); return;
  }
}

function required<T>(value: T | undefined, valueLabel: string): T {
  if (value === undefined) throw new Error(`Missing ${valueLabel}.`);
  return value;
}

function header(value: string | undefined): { type: "Text"; value: string } | undefined {
  return value === undefined ? undefined : { type: "Text", value };
}

/** Whether an action refers to a logical id, used to purge dependants after rejecting a create. */
export function actionReferences(action: DesignStudioAction, id: string): boolean {
  if ("targetId" in action && action.targetId === id) return true;
  if (action.type === "designClone" && action.sourceId === id) return true;
  if ((action.type === "designCreate" || action.type === "designClone") && action.parent.id === id) return true;
  return action.type === "designCreate" && action.input.templateId === id;
}
