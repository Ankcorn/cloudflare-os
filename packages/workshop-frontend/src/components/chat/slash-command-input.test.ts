import { describe, expect, it } from "vitest";
import type { SlashCommandChoice } from "@gadgets/workshop-shared/api";
import {
  exactSlashCommandMatches, filterSlashCommandCatalog, parseSlashCommandInput,
} from "./slash-command-input";

function parsed(input: string) {
  let result = parseSlashCommandInput(input);
  expect(result).not.toBeNull();
  if (!result) throw new Error(`Expected slash command input: ${input}`);
  return result;
}

const choices: SlashCommandChoice[] = [{
  selection: {gatekeeperId: 1, commandId: "skill-deploy"},
  name: "deploy",
  description: "Use the deployment runbook.",
  providerLabel: "Context Library",
  resourceLabel: "Runbooks",
}, {
  selection: {gatekeeperId: 2, commandId: "workflow-deploy"},
  name: "deploy",
  description: "Run the deployment workflow.",
  providerLabel: "GitHub",
}];

describe("slash command composer input", () => {
  it("separates the command from its prompt tail", () => {
    expect(parsed("/deploy staging")).toMatchObject({
      query: "deploy",
      tail: "staging",
      tokenEnd: 7,
      tailStart: 8,
    });
    expect(parsed("/deploy")).toMatchObject({
      query: "deploy",
      tail: "",
    });
  });

  it("leaves ordinary text and escaped leading slashes out of command parsing", () => {
    expect(parseSlashCommandInput("deploy staging")).toBeNull();
    expect(parseSlashCommandInput("//deploy staging")).toBeNull();
  });

  it("requires selection when command names are ambiguous", () => {
    expect(exactSlashCommandMatches(choices, parsed("/deploy staging"))).toEqual(choices);
    expect(exactSlashCommandMatches(choices, parsed("/dep staging"))).toEqual([]);
  });

  it("filters a loaded catalog locally", () => {
    expect(filterSlashCommandCatalog(choices, "runbook")).toEqual([choices[0]]);
    expect(filterSlashCommandCatalog(choices, "github")).toEqual([choices[1]]);
  });

  it("parses non-whitespace command tokens", () => {
    expect(parseSlashCommandInput("/skill:deploy")).toMatchObject({query: "skill:deploy"});
    let weird: SlashCommandChoice = {
      ...choices[0],
      name: "skill:deploy",
      selection: {gatekeeperId: 1, commandId: "skill:deploy"},
    };
    expect(exactSlashCommandMatches([weird], parsed("/skill:deploy"))).toEqual([weird]);
  });

  it("matches provider names without regard to case", () => {
    let mixedCase: SlashCommandChoice = {
      ...choices[0],
      name: "Deploy",
      selection: {gatekeeperId: 1, commandId: "mixed-case-deploy"},
    };
    expect(exactSlashCommandMatches([mixedCase], parsed("/deploy"))).toEqual([mixedCase]);
  });
});
