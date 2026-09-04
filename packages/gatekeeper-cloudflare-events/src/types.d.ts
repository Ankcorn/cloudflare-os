export type CloudflareJson = null | boolean | number | string | CloudflareJson[] | {
  [key: string]: CloudflareJson;
};

export interface CloudflareEvent {
  id: string;
  type: string;
  source: { [key: string]: CloudflareJson };
  metadata: {
    accountId: string;
    eventSubscriptionId: string;
    eventSchemaVersion: number;
    eventTimestamp: string;
  };
  payload: CloudflareJson;
}

export interface CloudflareEventSubscriptionSpec {
  source: { service: string; [key: string]: CloudflareJson };
  events: string[];
}

export interface CloudflareEventHook {
  onEvent(event: CloudflareEvent): Promise<void>;
}

export interface CloudflareEventSubscriptionSession {
  subscribe(
    subscription: CloudflareEventSubscriptionSpec,
    callback: RpcStub<CloudflareEventHook>,
  ): Promise<void>;
}
