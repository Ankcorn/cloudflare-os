import { createLogger } from "@gadgets/backend-utils/logger";

type MarketoLogFields = {
  vendorId: string;
  status: number;
};

export const logger = createLogger<MarketoLogFields>({
  component: "gatekeeper.marketo",
  vendorId: "marketo",
});
