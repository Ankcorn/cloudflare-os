export type WebhookConfiguratorValues = {
  endpointId?: string | null;
  label?: string | null;
};

export interface WebhookConfiguratorRpc {
  getLabel(endpointId: string): Promise<string | null>;
  resourceUrl(
    endpointId: string | null | undefined,
    label: string | null | undefined,
  ): Promise<string>;
}
