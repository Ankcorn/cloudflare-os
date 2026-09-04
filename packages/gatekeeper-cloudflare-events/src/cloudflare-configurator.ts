import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { listAccounts } from "./cloudflare-api.js";
import type { ConfiguratorUIOption } from "@gadgets/configurator-ui";
import type { CloudflareAccountConfiguratorRpc } from "./configurator/cloudflare-configurator-types.js";

const OPTION_LIMIT = 100;

@validateRpc()
export class CloudflareAccountConfiguratorUI extends RpcTarget implements CloudflareAccountConfiguratorRpc {
  constructor(private readonly getToken: () => Promise<string | null>) { super(); }
  async listAccounts(query: string): Promise<ConfiguratorUIOption[]> {
    const token = await this.getToken();
    if (!token) return [];
    const needle = query.trim().toLowerCase();
    return (await listAccounts(token)).filter(account => !needle || account.accountName.toLowerCase().includes(needle))
      .slice(0, OPTION_LIMIT).map(account => ({ value: account.accountId, title: account.accountName }));
  }
}
