# Webhook gatekeeper

Receives JSON over HTTP and delivers it to enabled Cloudflare OS hook subscriptions.

Each resource is an independent endpoint with a generated UUID, an optional display label, one
enabled subscriber, and its own 256-bit secret. `WebhookSession.issueCredential()` issues the
credential once. The plaintext is returned once; the receiver stores only its SHA-256 hash. Create
a new endpoint when credential rotation is required.

The HTTP router uses the dedicated `WEBHOOK_ENDPOINTS` KV namespace as a derived authentication
index. Unknown endpoint IDs and invalid credentials are rejected before a receiver Durable Object
is contacted or a request body is read. KV stores only the credential header name and hash; each
receiver remains authoritative for ownership, revocation, hook state, and delivery receipts.

Pass the returned `url`, `headerName`, and `headerValue` directly to the service that will send
webhooks. By default, requests use an HTTP Bearer credential:

```sh
curl --fail-with-body \
  -H 'Authorization: Bearer <api-key>' \
  -H 'Content-Type: application/json' \
  --data '{"message":"test"}' \
  'http://localhost:8787/gatekeeper/webhook/hooks/<endpoint-id>'
```

Providers can use their native secret header instead. For example,
`issueCredential({ headerName: "cf-webhook-auth" })` returns a raw generated secret suitable for
Cloudflare Notifications. A `valuePrefix` can be supplied for providers that require another
authentication scheme.

The endpoint accepts JSON documents up to 512 KiB. A `204` response means the event was delivered,
or that an event carrying the same `Idempotency-Key` was delivered previously. A `409` means no
subscription is enabled.

Send an `Idempotency-Key` header when the source provides a stable delivery ID. Without one, every
request receives a new event ID; identical JSON documents are treated as distinct events.

`BASE_URL` must be the gatekeeper's public HTTPS origin and path in a deployed environment, for
example `https://example.com/gatekeeper/webhook`. The localhost HTTP default exists only for local
development. The deployment must also provision and bind the `WEBHOOK_ENDPOINTS` KV namespace.

Pass a newly-issued credential directly to the sender or to a provider gatekeeper that configures
the sender. Do not log it or persist it in Gadget storage. Credential issuance and webhook delivery
are audited as observations, but neither sets the workspace-wide restricted-data latch. Webhook
resources remain owner-only because this gatekeeper rejects observer access.
