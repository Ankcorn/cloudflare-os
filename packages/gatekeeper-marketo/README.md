# Marketo gatekeeper

Gives Gadgets access to Adobe Marketo Engage people, CRM business objects, static lists, programs,
smart campaigns, activities, custom objects, and Design Studio assets.

## Authentication

Marketo uses 2-legged OAuth for REST API access. Each account connects with the endpoint, Client
ID, and Client Secret of a LaunchPoint custom service. The gatekeeper verifies the credential
before storing it. Its Marketo role defines the account's authority.

Create a credential in Marketo:

1. Under **Admin -> Security -> Users & Roles**, select **Create API Only User**, enter an email
   address, and assign the required roles.
2. Under **Admin -> Integration -> LaunchPoint**, select **New -> New Service**. Choose **Custom**,
   select the API-only user, and enter the required display name and description.
3. Create the service, open **View Details**, and copy its Client ID and Client Secret. Then go to
   **Admin -> Integration -> Web Services** and copy the **Endpoint** under **REST API**.

The connect URL contains a five-minute bearer nonce. It is served with `Cache-Control: no-store`
and `Referrer-Policy: no-referrer`, and the nonce is validated before credentials are sent to
Marketo.

### Deployment defaults

All settings are optional. A deployment can pre-fill the connection form with:

| Variable | Kind | Purpose |
| --- | --- | --- |
| `MARKETO_ENDPOINT` | var | Default instance endpoint |
| `MARKETO_CLIENT_ID` | var | Default Client ID |
| `MARKETO_CLIENT_SECRET` | secret | Default secret when the form is left blank |

Set `MARKETO_CLIENT_SECRET` with `wrangler secret put`. It is never rendered into the form and is
used only when the submitted endpoint and Client ID match the configured defaults. Configuring it
shares one LaunchPoint identity with every user who can connect to this deployment, so it is only
appropriate for a trusted single-team environment.

Reconnect updates the secret for the existing endpoint and Client ID. Switching to another
LaunchPoint service requires disconnecting and creating a new account so existing resource grants
cannot silently point at another Marketo instance.

## Resources

| Granularity | Session type | Access |
| --- | --- | --- |
| Instance | `MarketoSession` | Everything allowed by the connected role |
| Design Studio | `MarketoDesignStudio` | Classic assets plus the new Email Designer v2 emails, templates, and fragments; no people, activities, programs, or campaigns |
| Program | `MarketoProgram` | Members, tokens, metadata, tags, dates, lifecycle, and membership status for one program; no creation elsewhere |
| Static list | `MarketoStaticList` | Membership for one static list |

Concrete resource URLs include the Marketo instance origin. Advertised resource patterns use
`https://*.mktorest.com` so the vendor, connected accounts, and deployment policy refer to the same
resource types.

## Approvals

Reads authorize observations. Writes enter the approval queue and run only from `applyAction()`;
nothing is auto-approvable or automatically reversible.

Pending Design Studio, program-management, and smart-campaign management writes are reflected by
handle reads, including provisional creations and clones. Email Program approval and campaign
activation are not simulated because they may send or Marketo cannot validate the flow through
REST. Other pending writes are not simulated; they set `awaitDecision`,
return `void`, and callers should read the affected records after approval. Validation that can
happen before submission does: for example, program statuses and campaign types are checked before
an action reaches the approver.
Each binding can hold at most 200 pending actions; approve or reject queued work before submitting
more.

Marketo can report per-record failures inside a successful response. A fully skipped write remains
retryable; partial application is reported without replaying the successful records, and an empty
result is retained as uncertain rather than retried automatically.

## API behavior

- The REST quota is shared by every integration on the Marketo subscription. The client retries
  short-window rate limits with bounded backoff; daily quota failures are returned to the caller.
- Access tokens are cached per complete credential in a Durable Object.
- Paged Lead Database methods make one data request per page and return `moreResult` with
  `nextPageToken`. The first activity page also requests a paging token. Marketo omits
  `moreResult` on some Lead Database endpoints and can return a token on the final page, so the
  client treats an empty page as the terminal signal for those endpoints. Design Studio listings
  may also read individual pending assets to simulate queued writes.
- Campaign and static-list listings accept exact `name` or substring `nameContains` filters.
  Substring searches omit resources that belong to no program. Campaign searches may also match
  the containing program's name.
- Smart campaigns can be created, cloned, renamed, activated, deactivated, and deleted. Marketo's
  REST API cannot author flow steps or smart-list rules: creation produces an empty batch campaign,
  while cloning is the practical way to preserve a configured flow and audience. Campaign
  smart-list rules are exposed read-only.
- Programs can be created or cloned into ordinary folders and then renamed, retagged, dated,
  deleted, or approved/unapproved when they are Email Programs. Channel and tag definitions are
  discoverable first; required tags, allowed values, channel applicability, and paired Email
  Program dates are validated before an action is submitted. Costs, moves, and Engagement Program
  lifecycle operations are intentionally excluded.
- Programs support exact-name lookup but not substring search. Names are not unique, so callers
  should disambiguate with folder metadata or use a program ID.
- `MarketoDesignStudio.getEmailDesigner()` exposes new-designer emails, email templates, and
  fragments through the official `/asset/v2` endpoints. The whole-instance capability reaches the
  same surface through `getDesignStudio()`. These IDs are opaque strings and are tracked separately
  from classic assets, programs, and campaigns. All v2 writes use JSON, bearer-header auth, and
  `x-app-type: marketo`; activation and sending are intentionally excluded.
- Email Designer list operations require a workspace ID. `listWorkspaces()` discovers IDs through
  `/userservice/management/v1/users/workspaces.json`, which requires the connected role to have the
  additional **Access Users** and **Access User Management Api** permissions. It is optional when a
  workspace ID is already known.
- Designer reads expose only fields validated at the Marketo client boundary; raw editor context is
  neither returned nor mutable. Fragment type is immutable. Clone operations remain
  in the source location, matching the v2 API, and cannot accept a destination.
- Publishing a designer template can affect dependent assets; publishing a fragment can affect all
  inheriting assets. Approvals describe that propagation explicitly. Discard and deletion are
  irreversible, and deletion can break dependencies; use each handle's `getUsedBy()` first when in
  doubt. Force delete and public bulk delete are not exposed.
- Activity queries require explicit activity type IDs. Empty pages may still have
  `moreResult: true` because Marketo filters windows of the activity stream rather than paging only
  matching records.
- Person reads default to a small field set. Callers can use `describePersonFields()` to discover
  additional fields.
- Whole-instance sessions expose companies, opportunities, opportunity roles, sales people, and
  named accounts through `getBusinessObject()`. Describe preserves compound searchable field
  groups; queries accept simple field values or complete compound dedupe keys and page at 300.
- Standard business-object writes are approval-gated, not simulated, and irreversible. Companies,
  opportunities, opportunity roles, and sales people become read-only when describe reports native
  CRM management or Adobe rejects an approved write with `1018`; that status is cached by the
  binding and later writes are rejected before approval. Named accounts are exempt. Opportunity
  roles report unavailable when the connected role lacks permission, without affecting other
  business objects.

## Development

From the repository root:

```sh
pnpm exec vp run -F @gadgets/marketo-gatekeeper --no-cache test
pnpm exec vp run -F @gadgets/marketo-gatekeeper --no-cache build
pnpm run lint:check
```

The Vite+ test task builds the gitignored configurator modules before Vitest starts.
