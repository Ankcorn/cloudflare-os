import { describe, expect, it } from "vitest";

import {
  describeAction,
  describeActionForSubmission,
  MAX_APPROVAL_DESCRIPTION_BYTES,
  type MarketoAction,
} from "../src/actions";
import { markdownCodeBlock, markdownText } from "../src/approval-markdown";
import { DESIGN_STUDIO_RESOURCE, INSTANCE_RESOURCE, PROGRAM_RESOURCE } from "../src/config";
import { designerCloneSnapshot, designerDeleteSnapshot } from "../src/email-designer-actions";
import { matchesProgramApprovalDates } from "../src/program-actions";

describe("Marketo approval completeness", () => {
  it("preserves HTML-looking, entity, multiline, and backtick values in safe Markdown", () => {
    let value = "<target> &nbsp; *literal*\n# second `line`\n```";
    expect(markdownText(value)).toBe(
      "&lt;target&gt; &amp;nbsp; \\*literal\\*\n\\# second \\`line\\`\n\\`\\`\\`",
    );
    expect(markdownCodeBlock(value)).toBe(
      "    <target> &nbsp; *literal*\n    # second `line`\n    ```",
    );

    let textDescriptions = [
      describeAction({
        id: 1, type: "listAdd", listId: 7, listName: value, personIds: [1],
      }).description,
      describeAction({
        id: 2, type: "campaignMetadata", targetId: "8", campaignName: value,
        patch: { name: value, description: value },
      }).description,
      describeAction({
        id: 3, type: "programUpdate", targetId: "9", programName: value,
        patch: { name: value, description: value, tags: [{ tagType: value, tagValue: value }] },
      }).description,
    ];
    for (let description of textDescriptions) {
      expect(description).toContain("&lt;target&gt;");
      expect(description).toContain("&amp;nbsp;");
      expect(description).toContain("\\# second \\`line\\`");
      expect(description).not.toContain("<target>");
    }

    let codeDescriptions = [
      describeAction({
        id: 4, type: "businessObjectUpsert", kind: "company",
        records: [{ externalCompanyId: value, company: value }], matchBy: "dedupeFields",
        action: "createOrUpdate", changedFields: [value],
      }).description,
      describeAction({
        id: 5, type: "designContent", asset: "emailTemplate", targetId: "10", content: value,
      }).description,
      describeAction({
        id: 6, type: "designerCreate", asset: "designerEmail", provisionalId: "~1",
        body: { name: value, description: value, data: { html: value } },
      }).description,
    ];
    for (let description of codeDescriptions) {
      expect(description).toContain("<target>");
      expect(description).toContain("&nbsp;");
      expect(description).toContain("`");
      expect(description).not.toMatch(/more|\.\.\.|…/);
    }
    expect(codeDescriptions[1]).toContain(markdownCodeBlock(value));
  });

  it("advertises the complete instance and program authority", () => {
    expect(INSTANCE_RESOURCE.description).toMatch(/business objects.*Design Studio/i);
    expect(PROGRAM_RESOURCE.description).toMatch(/metadata.*tags.*dates.*approve.*delete/i);
  });

  it("advertises the complete Design Studio authority", () => {
    expect(DESIGN_STUDIO_RESOURCE.description).toMatch(/create or clone/i);
    expect(DESIGN_STUDIO_RESOURCE.description).toMatch(/content and metadata/i);
    expect(DESIGN_STUDIO_RESOURCE.description).toMatch(/publish.*propagate/i);
    expect(DESIGN_STUDIO_RESOURCE.description).toMatch(/permanently discard/i);
    expect(DESIGN_STUDIO_RESOURCE.description).toMatch(/permanently delete/i);
  });

  it("lists every recipient in bulk list, campaign, and program-status actions", () => {
    let personIds = Array.from({ length: 300 }, (_, index) => index + 1);
    let actions: MarketoAction[] = [
      { id: 1, type: "listAdd", listId: 7, listName: "All leads", personIds },
      { id: 2, type: "campaignTrigger", campaignId: 8, campaignName: "Launch", programId: null, personIds },
      { id: 3, type: "programStatus", programId: 9, programName: "Nurture", personIds, status: "Member" },
    ];

    for (let action of actions) {
      let description = describeAction(action).description;
      expect(description).toContain(personIds.join(", "));
      expect(description).not.toMatch(/more|\.\.\.|…/);
    }
  });

  it("shows every business-object target and submitted value without clipping", () => {
    let longValue = `<target>*${"x".repeat(200)}`;
    let records = Array.from({ length: 20 }, (_, index) => ({
      externalCompanyId: `${longValue}-${index + 1}`,
      company: `Company ${index + 1}`,
      attributes: { tier: index + 1 },
    }));
    let description = describeAction({
      id: 1,
      type: "businessObjectUpsert",
      kind: "company",
      records,
      matchBy: "dedupeFields",
      action: "createOrUpdate",
      changedFields: ["attributes", "company"],
    }).description;

    expect(description).toContain("Record 20");
    expect(description).toContain(`${longValue}-20`);
    expect(description).toContain('"company": "Company 20"');
    expect(description).toContain('"tier": 20');
    expect(description).not.toMatch(/more record|\.\.\.|…/);
  });

  it("shows every business-object upsert execution mode and execution-affecting field", () => {
    for (let action of ["createOnly", "updateOnly", "createOrUpdate"] as const) {
      let description = describeAction({
        id: 1,
        type: "businessObjectUpsert",
        kind: "company",
        records: [{ externalCompanyId: "company-7", company: "Acme" }],
        matchBy: "dedupeFields",
        action,
        changedFields: ["company"],
      }).description;

      expect(description).toContain(`Execution mode: **${action}**`);
      expect(description).toContain("Object type: **company**");
      expect(description).toContain("Matching mode: **dedupeFields**");
      expect(description).toContain('"externalCompanyId": "company-7"');
      expect(description).toContain('"company": "Acme"');
    }
  });

  it("describes every Email Designer create field in safe indented JSON", () => {
    let forged = "safe\n# forged approval\n```";
    let description = describeAction({
      id: 1,
      type: "designerCreate",
      asset: "designerEmail",
      provisionalId: "~1",
      body: {
        name: "Launch",
        description: forged,
        appData: { workspaceId: "w1", programId: "42", editorType: "email" },
        templateId: "template-7",
        data: { html: { body: "<h1>Exact</h1>" }, text: { body: "Exact" } },
        headers: { subject: "Subject", fromEmail: "sender@example.com", ccEmails: ["cc@example.com"] },
        settings: { isOperational: true, enableUrlTracking: false },
      },
    }).description;

    expect(description).toMatch(/Destination.*workspaceId.*programId/s);
    expect(description).toMatch(/Template ID.*template-7/s);
    expect(description).toMatch(/Content.*<h1>Exact<\/h1>/s);
    expect(description).toMatch(/Delivery headers.*sender@example.com.*cc@example.com/s);
    expect(description).toMatch(/settings.*isOperational.*enableUrlTracking/s);
    expect(description).not.toMatch(/(?:^|\n)(?:# forged approval|```)/);
  });

  it("describes the explicit and snapshotted inherited Email Designer clone fields", () => {
    let description = describeAction({
      id: 1,
      type: "designerClone",
      asset: "designerEmail",
      provisionalId: "~1",
      sourceId: "source-9",
      name: "Launch copy",
      description: "Explicit clone description",
      sourceSnapshot: designerCloneSnapshot({
        templateId: "template-7",
        appType: "marketing",
        appData: { workspaceId: "w1", programId: "42", editorType: "email" },
        data: { html: { body: "<h1>Inherited</h1>" }, text: { body: "Inherited" } },
        headers: { subject: "Inherited subject", fromEmail: "sender@example.com" },
        settings: { isOperational: true, enableUrlTracking: false },
      }),
    }).description;

    expect(description).toMatch(/Explicit description.*Explicit clone description/s);
    expect(description).toMatch(/Inherited destination.*workspaceId/s);
    expect(description).toMatch(/Inherited destination.*programId/s);
    expect(description).toMatch(/Inherited template ID.*template-7/s);
    expect(description).toMatch(/Inherited application type.*marketing/s);
    expect(description).toMatch(/Inherited content.*<h1>Inherited<\/h1>/s);
    expect(description).toMatch(/Inherited delivery headers.*Inherited subject/s);
    expect(description).toMatch(/Inherited delivery headers.*sender@example.com/s);
    expect(description).toMatch(/Inherited delivery or fragment settings.*isOperational/s);
    expect(description).toMatch(/Inherited delivery or fragment settings.*enableUrlTracking/s);
    expect(description).not.toMatch(/more|\.\.\.|…/);
  });

  it("shows complete classic and Designer lifecycle snapshots", () => {
    let classic = describeAction({
      id: 1,
      type: "designLifecycle",
      asset: "email",
      targetId: "21",
      operation: "approve",
      snapshot: {
        metadata: {
          name: "Launch",
          subject: "Exact subject",
          fromEmail: "sender@example.com",
          settings: { operational: true, isOpenTrackingDisabled: false },
        },
        content: [{ id: "main", html: "<h1>Exact draft</h1>", text: "Exact draft" }],
        affectedDependents: [],
      },
    }).description;
    let designer = describeAction({
      id: 2,
      type: "designerLifecycle",
      asset: "designerFragment",
      targetId: "fragment-1",
      operation: "approve",
      contentId: "draft-1",
      sourceState: "draft",
      sourceSnapshot: designerCloneSnapshot({
        data: { html: { body: "<section>Hero</section>" } },
        headers: { subject: "Fragment subject" },
        settings: { fragmentType: "email", supportedChannels: ["email"] },
      }),
      affectedDependents: [{
        id: "email-7", name: "Dependent email", workspaceId: "1", folderId: "10",
      }],
    }).description;

    expect(classic).toMatch(/Exact subject.*sender@example.com.*operational.*Exact draft/s);
    expect(classic).toContain("Affected dependents");
    expect(designer).toMatch(/Hero.*Fragment subject.*fragmentType.*supportedChannels/s);
    expect(designer).toMatch(/Affected dependents.*email-7.*Dependent email/s);
  });

  it("shows the complete Email Designer irreversible delete target and dependents", () => {
    let description = describeAction({
      id: 3,
      type: "designerDelete",
      asset: "designerEmail",
      targetId: "email-production",
      targetSnapshot: designerDeleteSnapshot({
        name: "Production renewal",
        description: "Live customer renewal",
        appData: { workspaceId: "production", programId: "renewal-program" },
        status: "approved",
        state: "approved",
        contentId: "approved-content-7",
        associatedStates: [{ contentId: "approved-content-7", state: "approved" }],
        templateId: "template-production",
        data: { html: { body: "<h1>Renew now</h1>" }, text: { body: "Renew now" } },
        headers: { subject: "Your renewal", fromEmail: "billing@example.com" },
        settings: { isOperational: true, enableUrlTracking: false },
      }),
      affectedDependents: [{
        id: "campaign-9", name: "Production renewal campaign", contentType: "Smart Campaign",
        workspaceId: "production", folderId: "campaigns",
      }],
    }).description;

    expect(description).toMatch(/email-production.*Production renewal.*Live customer renewal/s);
    expect(description).toMatch(/programId.*renewal-program.*workspaceId.*production/s);
    expect(description).toMatch(/approved-content-7.*approved/s);
    expect(description).toMatch(/template-production.*Renew now.*billing@example.com.*Your renewal/s);
    expect(description).toMatch(/enableUrlTracking.*isOperational/s);
    expect(description).toMatch(/Affected dependents.*campaign-9.*Production renewal campaign/s);
  });

  it("rejects an oversized Email Designer clone approval instead of truncating it", () => {
    let action: MarketoAction = {
      id: 1,
      type: "designerClone",
      asset: "designerEmail",
      provisionalId: "~1",
      sourceId: "source-9",
      name: "Large clone",
      description: "Explicit",
      sourceSnapshot: designerCloneSnapshot({
        appData: { workspaceId: "w1", programId: "42" },
        data: { html: { body: "x".repeat(MAX_APPROVAL_DESCRIPTION_BYTES) } },
        headers: {},
        settings: {},
      }),
    };

    expect(() => describeActionForSubmission(action)).toThrow(/split the action into smaller batches or payloads/);
  });

  it("rejects an action instead of truncating an oversized approval", () => {
    let action: MarketoAction = {
      id: 1,
      type: "designerCreate",
      asset: "designerTemplate",
      provisionalId: "~1",
      body: {
        name: "Large",
        appData: { workspaceId: "w1", folderId: "f1", editorType: "emailTemplate" },
        data: { html: { body: "x".repeat(MAX_APPROVAL_DESCRIPTION_BYTES) } },
      },
    };

    expect(() => describeActionForSubmission(action)).toThrow(/split the action into smaller batches or payloads/);
  });

  it("shows and matches the exact approved Email Program dates", () => {
    let action = {
      id: 1,
      type: "programLifecycle",
      targetId: "42",
      programName: "Newsletter",
      programType: "Email",
      operation: "approve",
      startDate: "2026-09-01T10:00:00.000Z",
      endDate: "2026-09-01T11:00:00.000Z",
    } as const;
    let description = describeAction(action).description;

    expect(description).toContain(action.startDate);
    expect(description).toContain(action.endDate);
    expect(matchesProgramApprovalDates(action, {
      id: 42,
      startDate: "2026-09-01T10:00:00Z+0000",
      endDate: "2026-09-01T11:00:00Z+0000",
    })).toBe(true);
    expect(matchesProgramApprovalDates({ ...action, targetId: "~1" }, {
      id: 42,
      startDate: "2026-09-01T10:00:00Z",
      endDate: "2026-09-01T11:00:00Z",
    }, 42)).toBe(true);
    expect(matchesProgramApprovalDates(action, {
      id: 42,
      startDate: "2026-09-01T10:05:00Z",
      endDate: "2026-09-01T11:00:00Z",
    })).toBe(false);
  });
});
