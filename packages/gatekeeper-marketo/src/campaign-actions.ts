import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { MarketoClient, MarketoFolderRef, RawAssetId, RawCampaignAsset } from "./marketo-api";

/** Approval-queued smart-campaign management operations. */
export type CampaignAction =
  | {
      id: number;
      type: "campaignCreate";
      provisionalId: string;
      parent: { id: string; type: "Folder" | "Program" };
      name: string;
      description?: string;
    }
  | {
      id: number;
      type: "campaignClone";
      provisionalId: string;
      sourceId: string;
      parent: { id: string; type: "Folder" | "Program" };
      name: string;
      description?: string;
    }
  | {
      id: number;
      type: "campaignMetadata";
      targetId: string;
      campaignName: string;
      patch: { name?: string; description?: string };
    }
  | {
      id: number;
      type: "campaignLifecycle";
      targetId: string;
      campaignName: string;
      campaignType?: string;
      operation: "activate" | "deactivate" | "delete";
    };

/** Campaign action before the gatekeeper assigns its approval id. */
export type CampaignActionInput = CampaignAction extends infer T
  ? T extends CampaignAction
    ? Omit<T, "id">
    : never
  : never;

/** Whether an arbitrary Marketo action is a campaign-management action. */
export function isCampaignAction(action: { type: string }): action is CampaignAction {
  return action.type.startsWith("campaign") && action.type !== "campaignTrigger" && action.type !== "campaignSchedule";
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+.!|>~-]/g, "\\$&");
}

function code(value: string): string {
  return `\`${escapeMarkdown(value)}\``;
}

/** Render a campaign-management action for human approval. */
export function describeCampaignAction(action: CampaignAction): ActionDescription {
  let base = { awaitDecision: false, implementsRevert: false } as const;
  switch (action.type) {
    case "campaignCreate":
      return {
        ...base,
        title: `Create Marketo smart campaign ${action.name}`,
        description:
          `Create empty smart campaign **${escapeMarkdown(action.name)}** in ` +
          `${action.parent.type.toLowerCase()} ${code(action.parent.id)}.` +
          (action.description ? `\n\nDescription: ${escapeMarkdown(action.description)}` : "") +
          "\n\nMarketo creates an empty batch campaign; its smart list and flow must be configured in Marketo before it can run.",
      };
    case "campaignClone":
      return {
        ...base,
        title: `Clone Marketo smart campaign ${action.name}`,
        description:
          `Clone smart campaign ${code(action.sourceId)} as **${escapeMarkdown(action.name)}** in ` +
          `${action.parent.type.toLowerCase()} ${code(action.parent.id)}. The clone uses the source campaign's current smart-list rules and flow steps when dispatched.` +
          (action.description ? `\n\nDescription: ${escapeMarkdown(action.description)}` : ""),
      };
    case "campaignMetadata":
      return {
        ...base,
        title: `Update Marketo smart campaign ${action.campaignName}`,
        description:
          `Update smart campaign **${escapeMarkdown(action.campaignName)}** (${code(action.targetId)}) metadata:` +
          (action.patch.name !== undefined ? `\n\n- Name: ${escapeMarkdown(action.patch.name)}` : "") +
          (action.patch.description !== undefined
            ? `\n- Description: ${escapeMarkdown(action.patch.description)}`
            : ""),
      };
    case "campaignLifecycle":
      return {
        ...base,
        awaitDecision: action.operation === "activate",
        title: `${action.operation} Marketo smart campaign ${action.campaignName}`,
        description: action.operation === "activate"
          ? `**Activate smart campaign ${escapeMarkdown(action.campaignName)} (${code(action.targetId)}).** Future people matching its triggers may immediately enter its flow, which can send messages or change data.`
          : action.operation === "delete"
            ? `**Permanently delete smart campaign ${escapeMarkdown(action.campaignName)} (${code(action.targetId)}).** This cannot be undone.`
            : `Deactivate smart campaign **${escapeMarkdown(action.campaignName)}** (${code(action.targetId)}) so future trigger matches no longer enter its flow.`,
      };
  }
}

type ResolveId = (id: string) => number;
type RecordCreation = (provisionalId: string, realId: number) => void;

function resultId(result: (RawCampaignAsset | RawAssetId)[], operation: string): number {
  let id = result[0]?.id;
  if (result.length !== 1 || !Number.isSafeInteger(id) || Number(id) <= 0) {
    throw new Error(`Marketo returned an invalid result for ${operation}.`);
  }
  return Number(id);
}

function folder(parent: { id: string; type: "Folder" | "Program" }, resolve: ResolveId): MarketoFolderRef {
  return { id: resolve(parent.id), type: parent.type };
}

async function verifyCreatedCampaign(client: MarketoClient, id: number, name: string, description: string | undefined, parent: MarketoFolderRef): Promise<void> {
  let created = await client.getSmartCampaign(id);
  let folderId = created?.folder?.id ?? created?.folder?.value;
  if (!created || created.id !== id || created.name !== name || folderId !== parent.id ||
      created.folder?.type !== parent.type || description !== undefined && created.description !== description) {
    throw new Error(`Marketo could not verify created smart campaign ${id} against the approved request.`);
  }
}

/** Execute one approved campaign-management action. */
export async function executeCampaignAction(
  action: CampaignAction,
  client: MarketoClient,
  resolve: ResolveId,
  recordCreation: RecordCreation,
  recordCandidate: (realId: number) => void = () => {},
): Promise<void> {
  if (action.type === "campaignCreate") {
    let parent = folder(action.parent, resolve);
    let result = await client.createSmartCampaign({
      name: action.name,
      description: action.description,
      folder: parent,
    });
    let id = resultId(result, "smart campaign creation");
    recordCandidate(id);
    await verifyCreatedCampaign(client, id, action.name, action.description, parent);
    recordCreation(action.provisionalId, id);
    return;
  }
  if (action.type === "campaignClone") {
    let parent = folder(action.parent, resolve);
    let result = await client.cloneSmartCampaign(resolve(action.sourceId), {
      name: action.name,
      description: action.description,
      folder: parent,
    });
    let id = resultId(result, "smart campaign clone");
    recordCandidate(id);
    await verifyCreatedCampaign(client, id, action.name, action.description, parent);
    recordCreation(action.provisionalId, id);
    return;
  }

  let id = resolve(action.targetId);
  let result = action.type === "campaignMetadata"
    ? await client.updateSmartCampaign(id, action.patch)
    : action.operation === "activate"
      ? await client.activateSmartCampaign(id)
      : action.operation === "deactivate"
        ? await client.deactivateSmartCampaign(id)
        : await client.deleteSmartCampaign(id);
  if (resultId(result, `smart campaign ${action.type === "campaignMetadata" ? "update" : action.operation}`) !== id) {
    throw new Error(`Marketo returned the wrong smart campaign id for action on ${id}.`);
  }
}

/** Whether an action depends on a logical id, used when purging rejected provisional work. */
export function campaignActionReferences(action: CampaignAction, id: string): boolean {
  if ("targetId" in action && action.targetId === id) return true;
  if (action.type === "campaignClone") return action.sourceId === id || action.parent.id === id;
  return action.type === "campaignCreate" && action.parent.id === id;
}
