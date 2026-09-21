/** JSON accepted by the local webhook trigger. */
export type WebhookJson = null | boolean | number | string | WebhookJson[] | {[key: string]: WebhookJson};

/** A normalized local webhook delivery. */
export interface WebhookEvent {
  id: string;
  timestamp: string;
  payload: WebhookJson;
}

/** Persistent callback implemented by a Gadget. */
export interface WebhookHook {
  onWebhook(event: WebhookEvent): Promise<void>;
}

/** Ambient local webhook capability. */
export interface WebhookSession {
  subscribe(callback: RpcStub<WebhookHook>): Promise<void>;
  getTriggerUrl(): Promise<string>;
}
