/** A value accepted in an inbound webhook JSON document. */
export type WebhookJson =
  | null | boolean | number | string | WebhookJson[] | { [key: string]: WebhookJson };

/** A normalized inbound webhook delivery. */
export interface WebhookEvent {
  /** Stable delivery identifier derived from Idempotency-Key, or from the request body. */
  id: string;
  /** Time the gatekeeper accepted the delivery, in ISO 8601 format. */
  timestamp: string;
  /** The complete JSON document sent by the webhook caller. */
  payload: WebhookJson;
}

/** Callback implemented by a Gadget that receives webhook deliveries. */
export interface WebhookHook {
  onWebhook(event: WebhookEvent): Promise<void>;
}

/** Options for the authentication header sent by a webhook provider. */
export interface WebhookCredentialOptions {
  /** Header carrying the secret. Defaults to `Authorization`. */
  headerName?: string;
  /** Text prepended to the generated secret. Defaults to `Bearer ` for Authorization, otherwise empty. */
  valuePrefix?: string;
}

/** Newly-issued credentials for configuring a webhook sender. */
export interface WebhookCredential {
  /** HTTP endpoint to which the sender should POST JSON. */
  url: string;
  /** Name of the HTTP header that carries the credential. */
  headerName: string;
  /** Complete one-time header value, including any configured prefix. */
  headerValue: string;
}

/** Capability for an HTTP webhook endpoint. */
export interface WebhookSession {
  /**
   * Subscribes to inbound webhook deliveries.
   *
   * @param callback A persistent stub created with `ctx.restore()` that implements WebhookHook.
   */
  subscribe(callback: RpcStub<WebhookHook>): Promise<void>;
  /** Returns the HTTP endpoint to which callers should POST JSON. */
  getTriggerUrl(): Promise<string>;
  /**
   * Issues this endpoint's credential once. Create a new endpoint when rotation is required.
   * The returned header value is shown only once and should be passed directly to the webhook sender.
   */
  issueCredential(options?: WebhookCredentialOptions): Promise<WebhookCredential>;
}
