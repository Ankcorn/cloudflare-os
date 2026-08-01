import { describe, expect, it } from "vitest";
import { formatCadence, formatTiming } from "./format";
import type { ManagementSchedule } from "../src/management-types";

const common = {
  scheduleId: "schedule-a",
  title: "Morning brief",
  description: "Prepare the morning brief.",
  workspaceId: "a".repeat(64),
};

describe("formatCadence", () => {
  it("describes interval, weekday, and one-shot schedules", () => {
    expect(formatCadence({ kind: "interval", everyMs: 3_600_000, anchorMs: 0 })).toBe("Every hour");
    expect(
      formatCadence({
        kind: "calendar",
        timeZone: "America/Chicago",
        rule: {
          freq: "weekly",
          interval: 1,
          byDay: ["MO", "TU", "WE", "TH", "FR"],
          hour: 8,
          minute: 0,
          anchorMs: 0,
        },
      }),
    ).toBe("Weekdays at 8:00 AM");
    expect(
      formatCadence({
        kind: "once",
        fireAt: Date.UTC(2026, 6, 30, 14),
        timeZone: "America/Chicago",
      }),
    ).toBe("Once on Jul 30, 2026 at 9:00 AM");
  });
});

describe("formatTiming", () => {
  it("uses bounded status copy and relative timestamps", () => {
    const now = Date.UTC(2026, 6, 30, 12);
    const active: ManagementSchedule = {
      ...common,
      cadence: { kind: "interval", everyMs: 3_600_000, anchorMs: 0 },
      status: "active",
      nextFire: now + 2 * 3_600_000,
    };
    const dead: ManagementSchedule = {
      ...common,
      cadence: { kind: "interval", everyMs: 3_600_000, anchorMs: 0 },
      status: "dead",
      failedAt: now - 60_000,
      failureCode: "authorization_failed",
    };

    expect(formatTiming(active, now).relative).toBe("Next run in 2 hours");
    expect(formatTiming(dead, now)).toMatchObject({
      relative: "Failed 1 minute ago",
      diagnostic: "Authorization failed after retries.",
    });
  });

  it("does not invent an absolute time while the next run is pending", () => {
    const active: ManagementSchedule = {
      ...common,
      cadence: { kind: "interval", everyMs: 3_600_000, anchorMs: 0 },
      status: "active",
    };

    expect(formatTiming(active, Date.UTC(2026, 6, 30, 12))).toEqual({
      relative: "Next run pending",
    });
  });
});
