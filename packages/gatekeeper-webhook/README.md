# Webhook gatekeeper

Receives JSON over HTTP and delivers it to enabled Cloudflare OS hook subscriptions.

Each resource is an independent endpoint with a generated UUID, an optional display label, one
enabled subscriber, and its own 256-bit secret. `WebhookSession.issueCredential()` issues the
credential once. The plaintext is returned once; the receiver stores only its SHA-256 hash. Create
a new endpoint when credential rotation is required.

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
or that the same event was delivered previously. A `409` means no subscription is enabled.

Send an `Idempotency-Key` header when the source provides a stable delivery ID. Otherwise the
gatekeeper derives the ID from the exact request body, so retrying an identical body is safe.

One-time credential issuance is intended for manual sender configuration in this standalone gatekeeper.
Passing a newly-issued secret automatically between two gatekeepers requires a trusted Workshop
broker; it should not be routed through Gadget code.
