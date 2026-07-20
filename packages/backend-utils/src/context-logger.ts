// oxlint-disable-next-line typescript/triple-slash-reference -- Makes the focused ALS type available to source consumers.
/// <reference path="./node-async-hooks.d.ts" />

import { AsyncLocalStorage } from "node:async_hooks";
import {
  createLoggerWithContext, type LogValue, type ReservedLogField,
} from "./logger-core.js";

export type { Logger, LogValue } from "./logger-core.js";

type ValidContextFields<Fields extends object> = {
  [Key in keyof Fields]: Fields[Key] extends LogValue ? Fields[Key] : never;
} & { [Key in ReservedLogField]?: never };

const logContext = new AsyncLocalStorage<Readonly<Record<string, LogValue>>>();

/**
 * Runs a callback with fields inherited by contextual loggers in its asynchronous scope.
 * Nested scopes restore their parent context when the callback returns or throws.
 *
 * Workers does not fully support propagating ALS through custom thenables. Callers that interact
 * with RPC promises should keep the scope bounded to one in-flight operation and must not assume
 * its context survives Durable Object hibernation or restart.
 */
export function withLogContext<Fields extends object, Result>(
  fields: Readonly<ValidContextFields<Fields>>,
  callback: () => Result,
): Result {
  return logContext.run({ ...logContext.getStore(), ...fields }, callback);
}

/** Creates an ALS-enabled structured Worker logger with fixed component metadata. */
export function createLogger<ExtraFields extends object = Record<never, never>>(
  defaults: Parameters<typeof createLoggerWithContext<ExtraFields>>[0],
) {
  return createLoggerWithContext<ExtraFields>(defaults, () => logContext.getStore());
}
