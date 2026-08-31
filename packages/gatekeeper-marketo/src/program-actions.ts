import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { parseMarketoDate, type MarketoClient, type MarketoProgramTag, type RawAssetId, type RawProgram } from "./marketo-api";

type ProgramPatch = {
  name?: string;
  description?: string;
  tags?: MarketoProgramTag[];
  startDate?: string;
  endDate?: string;
};

/** Approval-queued program-management operations. */
export type ProgramAction =
  | {
      id: number;
      type: "programCreate";
      provisionalId: string;
      parentId: string;
      input: Required<Pick<ProgramPatch, "name">> & ProgramPatch & { type: string; channel: string };
    }
  | {
      id: number;
      type: "programClone";
      provisionalId: string;
      sourceId: string;
      parentId: string;
      name: string;
      description?: string;
    }
  | {
      id: number;
      type: "programUpdate";
      targetId: string;
      programName: string;
      patch: ProgramPatch;
    }
  | {
      id: number;
      type: "programLifecycle";
      targetId: string;
      programName: string;
      programType?: string;
      operation: "approve";
      startDate: string;
      endDate: string;
    }
  | {
      id: number;
      type: "programLifecycle";
      targetId: string;
      programName: string;
      programType?: string;
      operation: "unapprove" | "delete";
    };

/** Program action before the gatekeeper assigns its approval id. */
export type ProgramActionInput = ProgramAction extends infer T
  ? T extends ProgramAction
    ? Omit<T, "id">
    : never
  : never;

/** Whether an arbitrary Marketo action manages a program asset. */
export function isProgramAction(action: { type: string }): action is ProgramAction {
  return action.type === "programCreate" || action.type === "programClone" ||
    action.type === "programUpdate" || action.type === "programLifecycle";
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+.!|>~-]/g, "\\$&");
}

function code(value: string): string {
  return `\`${escapeMarkdown(value)}\``;
}

function patchDetails(patch: ProgramPatch): string {
  let details: string[] = [];
  if (patch.name !== undefined) details.push(`- Name: ${escapeMarkdown(patch.name)}`);
  if (patch.description !== undefined) details.push(`- Description: ${escapeMarkdown(patch.description)}`);
  if (patch.tags !== undefined) {
    details.push(`- Tags: ${patch.tags.map(tag => `${escapeMarkdown(tag.tagType)} = ${escapeMarkdown(tag.tagValue)}`).join(", ") || "none"}`);
  }
  if (patch.startDate !== undefined) details.push(`- Start: ${patch.startDate}`);
  if (patch.endDate !== undefined) details.push(`- End: ${patch.endDate}`);
  return details.join("\n");
}

/** Render a program-management action for human approval. */
export function describeProgramAction(action: ProgramAction): ActionDescription {
  let base = { awaitDecision: false, implementsRevert: false } as const;
  switch (action.type) {
    case "programCreate":
      return {
        ...base,
        title: `Create Marketo program ${action.input.name}`,
        description: `Create **${escapeMarkdown(action.input.name)}**, a ${escapeMarkdown(action.input.type)} program using channel ${escapeMarkdown(action.input.channel)}, in folder ${code(action.parentId)}.\n\n${patchDetails(action.input)}`,
      };
    case "programClone":
      return {
        ...base,
        title: `Clone Marketo program ${action.name}`,
        description: `Clone program ${code(action.sourceId)} as **${escapeMarkdown(action.name)}** in folder ${code(action.parentId)}, using the source program's current contents when dispatched.` +
          (action.description === undefined ? "" : `\n\nDescription: ${escapeMarkdown(action.description)}`),
      };
    case "programUpdate":
      return {
        ...base,
        title: `Update Marketo program ${action.programName}`,
        description: `Update program **${escapeMarkdown(action.programName)}** (${code(action.targetId)}):\n\n${patchDetails(action.patch)}`,
      };
    case "programLifecycle":
      return {
        ...base,
        awaitDecision: action.operation === "approve",
        title: `${action.operation} Marketo program ${action.programName}`,
        description: action.operation === "approve"
          ? `**Approve Email Program ${escapeMarkdown(action.programName)} (${code(action.targetId)}).** It may send its configured email to real people.\n\nExact approved schedule:\n- Start: ${action.startDate}\n- End: ${action.endDate}`
          : action.operation === "delete"
            ? `**Permanently delete program ${escapeMarkdown(action.programName)} (${code(action.targetId)}).** This cannot be undone.`
            : `Unapprove Email Program **${escapeMarkdown(action.programName)}** (${code(action.targetId)}) so it will not run as scheduled.`,
      };
  }
}

/** Whether Marketo still reports the exact Email Program dates captured for approval. */
export function matchesProgramApprovalDates(
  action: Extract<ProgramAction, { type: "programLifecycle"; operation: "approve" }>,
  program: RawProgram | undefined,
  targetId = Number(action.targetId),
): boolean {
  return Boolean(program && program.id === targetId &&
    parseMarketoDate(program.startDate)?.toISOString() === action.startDate &&
    parseMarketoDate(program.endDate)?.toISOString() === action.endDate);
}

function resultId(result: (RawProgram | RawAssetId)[], operation: string): number {
  let id = result[0]?.id;
  if (result.length !== 1 || !Number.isSafeInteger(id) || Number(id) <= 0) {
    throw new Error(`Marketo returned an invalid result for ${operation}.`);
  }
  return Number(id);
}

async function verifyCreatedProgram(
  client: MarketoClient,
  id: number,
  approved: { name: string; description?: string; type?: string; channel?: string; tags?: unknown; startDate?: string; endDate?: string },
  parentId: number,
): Promise<void> {
  let created = await client.getProgram(id);
  if (!created || created.id !== id || created.name !== approved.name ||
      created.folder?.value !== parentId || created.folder.type !== "Folder" ||
      Object.entries(approved).some(([key, value]) => value !== undefined &&
        JSON.stringify(created[key as keyof typeof created]) !== JSON.stringify(value))) {
    throw new Error(`Marketo could not verify created program ${id} against the approved request.`);
  }
}

/** Execute one approved program-management action. */
export async function executeProgramAction(
  action: ProgramAction,
  client: MarketoClient,
  resolve: (id: string) => number,
  recordCreation: (provisionalId: string, realId: number) => void,
  recordCandidate: (realId: number) => void = () => {},
): Promise<void> {
  if (action.type === "programCreate") {
    let parentId = resolve(action.parentId);
    let result = await client.createProgram({
      ...action.input,
      folder: { id: parentId, type: "Folder" },
    });
    let id = resultId(result, "program creation");
    recordCandidate(id);
    await verifyCreatedProgram(client, id, action.input, parentId);
    recordCreation(action.provisionalId, id);
    return;
  }
  if (action.type === "programClone") {
    let parentId = resolve(action.parentId);
    let result = await client.cloneProgram(resolve(action.sourceId), {
      name: action.name,
      description: action.description,
      folder: { id: parentId, type: "Folder" },
    });
    let id = resultId(result, "program clone");
    recordCandidate(id);
    await verifyCreatedProgram(client, id, { name: action.name, description: action.description }, parentId);
    recordCreation(action.provisionalId, id);
    return;
  }
  let id = resolve(action.targetId);
  let result = action.type === "programUpdate"
    ? await client.updateProgram(id, action.patch)
    : action.operation === "approve"
      ? await client.approveProgram(id)
      : action.operation === "unapprove"
        ? await client.unapproveProgram(id)
        : await client.deleteProgram(id);
  if (resultId(result, `program ${action.type === "programUpdate" ? "update" : action.operation}`) !== id) {
    throw new Error(`Marketo returned the wrong program id for action on ${id}.`);
  }
}

/** Whether an action depends on a logical id. */
export function programActionReferences(action: ProgramAction, id: string): boolean {
  if ("targetId" in action) return action.targetId === id;
  if (action.type === "programClone") return action.sourceId === id || action.parentId === id;
  return action.parentId === id;
}
