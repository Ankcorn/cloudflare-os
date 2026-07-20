import { createLogger } from "../src/logger.js";
import { withLogContext } from "../src/context-logger.js";

let logger = createLogger<{
  accountId?: number;
  chatId?: number;
  durationMs?: number;
  providerRequestId?: string;
}>({ component: "test" });
let loggerWithoutPackageFields = createLogger({ component: "test" });
let loggerWithSensitivePackageFields = createLogger<{
  body?: string;
  header?: string;
  headers?: string;
  prompt?: string;
  secret?: string;
  token?: string;
}>({ component: "test" });
// @ts-expect-error sensitive fields cannot be logger defaults even when declared
createLogger<{ token?: string }>({ component: "test", token: "private token" });
logger.info("valid", { event: "valid", accountId: 1, providerRequestId: "request-1" });
logger.with({ chatId: 1 });
logger.with({ providerRequestId: "request-2" });
withLogContext({ operation: "test.operation" }, () => {});
// @ts-expect-error sensitive fields are not accepted in ambient context
withLogContext({ token: "private token" }, () => {});
// @ts-expect-error errors belong to individual log entries, not ambient context
withLogContext({ error: "boom" }, () => {});
// @ts-expect-error error stacks are produced by the logger, not ambient context
withLogContext({ errorStack: "stack" }, () => {});
// @ts-expect-error components are fixed when a logger is created
withLogContext({ component: "other" }, () => {});
// @ts-expect-error events belong to individual log entries, not ambient context
withLogContext({ event: "other" }, () => {});
// @ts-expect-error messages are the first argument to a log method
withLogContext({ message: "other" }, () => {});

// @ts-expect-error event is required
logger.info("missing event", { accountId: 1 });
// @ts-expect-error misspelled package field
logger.info("misspelled", { event: "invalid", acountId: 1 });
// @ts-expect-error invalid shared field type
logger.info("wrong type", { event: "invalid", durationMs: "slow" });
// @ts-expect-error sensitive fields are not accepted
logger.info("sensitive", { event: "invalid", body: "secret" });
// @ts-expect-error sensitive fields remain prohibited when declared in the package vocabulary
loggerWithSensitivePackageFields.info("sensitive", { event: "invalid", body: "secret" });
// @ts-expect-error sensitive fields remain prohibited when declared in the package vocabulary
loggerWithSensitivePackageFields.with({ header: "authorization" });
// @ts-expect-error sensitive fields remain prohibited when declared in the package vocabulary
loggerWithSensitivePackageFields.with({ headers: "authorization" });
// @ts-expect-error sensitive fields remain prohibited when declared in the package vocabulary
loggerWithSensitivePackageFields.with({ prompt: "private prompt" });
// @ts-expect-error sensitive fields remain prohibited when declared in the package vocabulary
loggerWithSensitivePackageFields.with({ secret: "private secret" });
// @ts-expect-error sensitive fields remain prohibited when declared in the package vocabulary
loggerWithSensitivePackageFields.with({ token: "private token" });
// @ts-expect-error misspelled package-local field
logger.with({ providerRequstId: "request-3" });
// @ts-expect-error errors belong to individual log entries, not inherited logger context
logger.with({ error: new Error("boom") });
// @ts-expect-error package fields must be declared on this logger
loggerWithoutPackageFields.info("undeclared", { event: "invalid", accountId: 1 });
