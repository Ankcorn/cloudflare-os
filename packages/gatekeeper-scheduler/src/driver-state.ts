import type { ScheduleSpec } from "./schedule-types.js";
import { initialNextFire, nextFireAfter } from "./scheduler-core.js";

/** Maximum callback attempts for one logical run. */
export const MAX_ATTEMPTS = 8;
/** Initial callback retry delay. */
export const RETRY_BASE_MS = 60_000;
/** Maximum callback retry delay. */
export const RETRY_MAX_MS = 3_600_000;

/** Immutable registration data retained by a hook controller. */
export type ScheduleRegistration = {
  workspaceId: string;
  scheduleId: string;
  spec: ScheduleSpec;
};

/** An enabled schedule waiting for its next occurrence. */
export type ActiveSchedule = ScheduleRegistration & {
  status: "active";
  nextFire: number;
};

/** A one-shot whose firing instant passed without delivery. */
export type ExpiredSchedule = ScheduleRegistration & {
  status: "expired";
  expiredAt: number;
};

/** A logical run currently crossing an external delivery boundary. */
export type PendingSchedule = ScheduleRegistration & {
  status: "pending";
  stage: "admission" | "delivery";
  runId: string;
  scheduledTime: number;
  attempts: number;
  leaseExpiresAt: number;
  nextFire?: number;
};

/** A logical run waiting for its next callback attempt. */
export type RetryingSchedule = ScheduleRegistration & {
  status: "retrying";
  runId: string;
  scheduledTime: number;
  attempts: number;
  nextAttempt: number;
  nextFire?: number;
};

/** A logical run that exhausted its callback attempt budget. */
export type DeadSchedule = ScheduleRegistration & {
  status: "dead";
  runId: string;
  attempts: number;
  failedAt: number;
  failureCode: "authorization_failed" | "callback_failed";
};

/** A one-shot whose callback completed successfully. */
export type CompletedSchedule = ScheduleRegistration & {
  status: "completed";
  runId: string;
  completedAt: number;
};

/** Persisted state for one enabled schedule. */
export type EnabledSchedule =
  | ActiveSchedule
  | PendingSchedule
  | RetryingSchedule
  | DeadSchedule
  | CompletedSchedule
  | ExpiredSchedule;

/** Creates enabled state without replaying occurrences at or before `now`. */
export function createSchedule(registration: ScheduleRegistration, now: number): EnabledSchedule {
  const common = copyRegistration(registration);
  const nextFire = initialNextFire(registration.spec, now);
  return nextFire === undefined
    ? { ...common, status: "expired", expiredAt: now }
    : { ...common, status: "active", nextFire };
}

/** Starts a due occurrence or retry, maintaining one logical run per schedule. */
export function beginDueRun(
  schedule: EnabledSchedule,
  now: number,
  runId: string,
  leaseExpiresAt: number,
): EnabledSchedule {
  if (schedule.status === "active") {
    if (schedule.nextFire > now) return schedule;
    if (!runId) throw new TypeError("A run ID is required.");
    return {
      ...schedule,
      status: "pending",
      stage: "admission",
      runId,
      scheduledTime: schedule.nextFire,
      attempts: 0,
      leaseExpiresAt,
      nextFire: undefined,
    };
  }
  if (schedule.status !== "retrying" || schedule.nextAttempt > now) return schedule;
  return {
    ...copyRegistration(schedule),
    status: "pending",
    stage: "admission",
    runId: schedule.runId,
    scheduledTime: schedule.scheduledTime,
    attempts: schedule.attempts,
    leaseExpiresAt,
    nextFire: schedule.nextFire,
  };
}

/** Records successful admission before authorization or callback delivery. */
export function admitRun(
  schedule: EnabledSchedule,
  runId: string,
  now: number,
  leaseExpiresAt: number,
): EnabledSchedule {
  if (!isPending(schedule, runId, "admission")) return schedule;
  return {
    ...schedule,
    stage: "delivery",
    attempts: schedule.attempts + 1,
    leaseExpiresAt,
    nextFire: recurringNextFire(schedule.spec, now),
  };
}

/** Abandons a run after admission rejects without consuming a callback attempt. */
export function rejectRun(
  schedule: EnabledSchedule,
  runId: string,
  rejectedAt: number,
): EnabledSchedule {
  if (!isPending(schedule, runId, "admission")) return schedule;
  return schedule.spec.kind === "once"
    ? {
        ...copyRegistration(schedule),
        status: "expired",
        expiredAt: rejectedAt,
      }
    : {
        ...copyRegistration(schedule),
        status: "active",
        nextFire: nextFireAfter(schedule.spec, rejectedAt)!,
      };
}

/** Schedules a callback retry or marks an exhausted logical run dead. */
export function failRun(
  schedule: EnabledSchedule,
  runId: string,
  failureCode: "authorization_failed" | "callback_failed",
  failedAt: number,
): EnabledSchedule {
  if (!isPending(schedule, runId, "delivery")) return schedule;
  if (schedule.attempts >= MAX_ATTEMPTS) {
    return {
      ...copyRegistration(schedule),
      status: "dead",
      runId,
      attempts: schedule.attempts,
      failedAt,
      failureCode,
    };
  }
  return {
    ...copyRegistration(schedule),
    status: "retrying",
    runId,
    scheduledTime: schedule.scheduledTime,
    attempts: schedule.attempts,
    nextAttempt: checkedAdd(failedAt, retryDelay(schedule.attempts)),
    nextFire: recurringNextFire(schedule.spec, failedAt),
  };
}

/** Completes a logical run and advances recurring cadence from completion time. */
export function completeRun(
  schedule: EnabledSchedule,
  runId: string,
  completedAt: number,
): EnabledSchedule {
  if (!isPending(schedule, runId, "delivery")) return schedule;
  return schedule.spec.kind === "once"
    ? {
        ...copyRegistration(schedule),
        status: "completed",
        runId,
        completedAt,
      }
    : {
        ...copyRegistration(schedule),
        status: "active",
        nextFire: nextFireAfter(schedule.spec, completedAt)!,
      };
}

/** Returns exponential callback retry delay for an already-consumed attempt. */
export function retryDelay(attempts: number): number {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS) {
    throw new RangeError(`Attempts must be an integer from 1 through ${MAX_ATTEMPTS}.`);
  }
  return Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
}

function isPending(
  schedule: EnabledSchedule,
  runId: string,
  stage?: PendingSchedule["stage"],
): schedule is PendingSchedule {
  return (
    schedule.status === "pending" &&
    schedule.runId === runId &&
    (stage === undefined || schedule.stage === stage)
  );
}

function recurringNextFire(spec: ScheduleSpec, now: number): number | undefined {
  return spec.kind === "once" ? undefined : nextFireAfter(spec, now);
}

function copyRegistration(registration: ScheduleRegistration): ScheduleRegistration {
  return {
    workspaceId: registration.workspaceId,
    scheduleId: registration.scheduleId,
    spec: registration.spec,
  };
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError("Retry deadline exceeds the supported range.");
  }
  return result;
}
