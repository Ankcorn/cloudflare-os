# Blueprints

Blueprints let a user share a gadget's source code so that others can create their own gadget instances from it. A blueprint captures the code but not the chat history, SQLite storage, or credentials. Each gadget created from a blueprint gets its own bindings, storage, and chat history.

This is analogous to a template: the blueprint author publishes a reusable gadget design, and anyone with the link can stamp out their own copy, pointing it at their own resources.

## Key Properties

- A single gadget can have **multiple blueprints**, potentially at different code versions (e.g. a "stable" and a "latest" blueprint of the same gadget).
- Each blueprint has a **128-bit random hex ID**, generated server-side.
- Blueprints are shared via link: `https://<host>/blueprint/<hex-id>`.
- Anyone with the link can **view** the blueprint's metadata (title, description, author, required bindings) without authenticating. **Creating a gadget** from a blueprint requires authentication.
- A blueprint is always owned by the gadget's owner, regardless of which collaborator creates it.
- The blueprint author can **update** a blueprint to reflect newer code, incrementing its version number. Old code versions are retained in storage to avoid race conditions during concurrent instantiation.
- Blueprints can be exported to a `.gadget` file and imported into a different Workshop instance.

## What a Blueprint Captures

A blueprint captures:

- **Source code** -- a snapshot of the gadget's committed Yjs document, stripped of edit history. The snapshot contains only the final file contents (one insert operation per file), producing a minimal encoding.
- **Binding requirements** -- a description of each named binding the gadget uses, including what type of connection is needed (gatekeeper, AI model, or agent spawner) and how to configure it. The blueprint does not include any credentials or live connections.
- **Metadata** -- title, description, author info, version number, and timestamps.

A blueprint does **not** capture:

- The gadget's SQLite storage contents.
- AI chat history or edit history.
- Live connections or credentials. Only the *shape* of each binding (its type, gatekeeper name, URL pattern, etc.) is recorded.

## Binding Annotations

Before creating a blueprint, the author can optionally add **blueprint annotations** for the gadget's named bindings. This user-provided metadata controls how each required connection appears to someone creating a gadget from the blueprint:

- **Name** -- a friendly connection name shown to blueprint consumers. It defaults to the current resource title, while the binding name remains the stable key used by code.
- **Description** -- optional helper text that tells the blueprint consumer what kind of resource to connect.
- **Suggest value** -- optionally includes the specific resource URL or model name as a suggestion. This is useful when the blueprint author intends all instances to use the same resource, but it remains a suggestion rather than a requirement.

All named bindings are included in the blueprint. Annotations are configured in the **Blueprint** modal opened from the gadget editor header. The annotation is stored on the `GatekeeperRecord` as the `blueprintAnnotation` field.

## Binding Types

Blueprints support three types of bindings, matching the three types of gatekeepers:

1. **Gatekeeper** (`type: "gatekeeper"`) -- an external resource connection (e.g. Google Drive, a REST API). The blueprint records the gatekeeper adapter name and a URL pattern describing what kind of resource is expected. When instantiating, the user picks a connected account and provides a resource URL.

2. **AI Model** (`type: "aiModel"`) -- a language model binding. The blueprint may suggest a specific provider/model. When instantiating, the user picks from their own configured models.

3. **Agent Spawner** (`type: "agentSpawner"`) -- an agent spawner binding. The blueprint carries over the spawner configuration (prompt types, env restrictions) from the source gadget. The user only needs to choose which model the spawner should use (or no model).

## Storage Architecture

Blueprint data is stored in three places, with one-way propagation: Gadget DO -> User DO -> Workers KV.

1. **Gadget DO** (`blueprints` collection) -- the authoritative source. Stores `BlueprintGadgetRecord` including full metadata, the code version that was exported, and a `dirty` flag for tracking propagation failures.

2. **User DO** (`blueprints` collection) -- a denormalized copy for efficient listing. Stores `BlueprintUserRecord` with metadata and a reference to the source gadget. This allows a user to audit and manage their blueprints even if the source gadget has been deleted.

3. **Workers KV** (`BLUEPRINTS` namespace) -- the public-facing lookup store. Stores `BlueprintKvRecord` keyed by blueprint hex ID. This is what `PublicApi.getBlueprint()` reads from.

Blueprint **code content** is stored separately in an **R2 bucket** (`BLUEPRINT_CONTENT`). The R2 key is `<blueprintId>/<version>`. Content is stored as a Yjs V2-encoded document (the full state, not incremental updates). When a blueprint is updated, old versions are retained to avoid race conditions. When a blueprint is deleted, all its R2 versions are cleaned up.

The `dirty` flag handles propagation failures gracefully: it is set to `true` before propagation begins and cleared only after all writes succeed. If a failure leaves it set, the UI shows a warning with a "Retry" button.

## Blueprint Library

The Blueprints page shows blueprints in two sections:

- **Blueprints** -- a merged grid of featured picks and the user's saved library entries (deduplicated, featured first). An Upload button lets users import `.gadget` archives.
- **My Blueprints** -- blueprints you published from gadgets you own. These are backed by a gadget DO, mirrored into your User DO, and published through KV.

Library entries come in two forms:

- **Saved by reference** -- created by `addBlueprintToLibrary()`. The entry stores a cached copy of the blueprint's public metadata for list rendering, but the actual blueprint remains owned by the original publisher. Removing it only deletes your personal library entry.
- **Uploaded** -- created by `importBlueprint()` from a `.gadget` archive. This creates a new local blueprint ID on the current deployment, stores the snapshot in this deployment's R2/KV, and records it in your library with `uploaded: true`. Removing one of these entries deletes the imported blueprint content as well.

## Export / Import Format

Blueprints can be downloaded from `/blueprint/<id>` as `.gadget` files and uploaded from the home page into another Workshop instance.

The `.gadget` format is a simple internal binary container:

- 8-byte magic number: `0xec2e2d3a2300e317`
- 4-byte format version (`1`)
- 4-byte JSON metadata length
- 8-byte raw content length
- JSON-encoded `BlueprintMetadata`
- Raw blueprint content bytes copied from `BLUEPRINT_CONTENT/<blueprintId>/<version>`

Imports are validated before publication. Metadata is capped at 64 KiB and the stored snapshot payload is capped at 32 MiB so a malformed archive cannot force unbounded allocation in the worker.

Only `BlueprintMetadata` is included in the file, not the full KV record. In particular, the archive does not include `ownerId` or `gadgetId`.

The trailing content bytes are the same gzip-compressed Yjs snapshot that is already stored in R2 for the blueprint's current version. Import/export streams these bytes directly to and from R2 using `pipeTo()` rather than buffering the whole archive in memory on the server.

## Admin Features and Featured Blueprints

Deployments can optionally configure a set of admin usernames through the backend worker's `ADMINS` binding as an array of usernames.

Admins get access to two extra RPCs:

- `AuthenticatedApi.adminIsBlueprintFeatured()` returns whether a published blueprint is currently featured.
- `AuthenticatedApi.adminSetBlueprintFeatured()` marks or unmarks a blueprint as featured.

Only gadget-backed published blueprints are featureable. Uploaded/imported library blueprints are intentionally excluded.

Featured blueprint state is split across two stores:

- The authoritative `featured` bit lives in the owning user's `blueprints` record inside their User DO.
- The `AdminSettings` durable object is a singleton (`getByName("")`) that mirrors the current public metadata for featured blueprints and writes a KV snapshot consumed by `AuthenticatedApi.listFeaturedBlueprints()`.

## Creating and Managing Blueprints

Blueprints are managed through the **Blueprint** button in the gadget editor header. The UI allows:

- **Creating** a new blueprint from the gadget's current committed code, with a title and optional description.
- **Describing** the required connections with optional per-binding helper text and suggested values.
- **Listing** existing blueprints with their title, description, version, and code version date.
- **Editing** a blueprint's title and description inline.
- **Updating** a blueprint to the gadget's current code (increments the version).
- **Copying** the blueprint's share link to the clipboard.
- **Deleting** a blueprint (with confirmation).
- **Retrying** a failed publish when the dirty flag is set.

On the backend, the Overseer handles blueprint lifecycle through `createBlueprint`, `updateBlueprint`, `deleteBlueprint`, and `retryBlueprintPublish`. Blueprint creation generates a random ID, collects binding metadata from all annotated gatekeepers (via `collectBindingMetadata`), snapshots the code (via `snapshotCode`), and propagates to all three storage locations (via `propagateBlueprint`).

## Instantiating a Blueprint

When someone opens a blueprint link (`/blueprint/<id>`), they see the **Blueprint Landing Page**:

1. The page fetches metadata via `PublicApi.getBlueprint()` (unauthenticated -- knowing the ID is sufficient since a blueprint is just data).
2. It displays the title, description, author, version, and a summary of required bindings.
3. If the user is not logged in, they see a "Log in to create a gadget" button.
4. Once authenticated, the user enters **configure mode**, where they assign each required binding:
   - For gatekeeper bindings: pick a connected account and provide a resource URL.
   - For AI model bindings: pick from their configured models.
   - For agent spawner bindings: pick a model (or none).
5. Clicking "Create Gadget" calls `AuthenticatedApi.newGadgetFromBlueprint()`, which:
   - Reads the blueprint from KV and its code from R2.
   - Creates a new Overseer DO and initializes it with the blueprint's code via `initializeFromBlueprint`.
   - Creates gatekeepers from the user's binding assignments (pipelined for performance).
   - Returns the new Overseer stub, and the UI redirects to the new gadget.

The new gadget is independent from the blueprint source: it has its own storage, chat history, and bindings. There is currently no mechanism for automatic updates from the blueprint to existing instances (though the Yjs-based storage format could support this in the future).

When a `.gadget` file is uploaded, the target instance creates a new local blueprint ID, stores the uploaded code snapshot in its own R2 bucket, writes the imported metadata to its own KV namespace, and records the blueprint under the importing user's account. The original blueprint author metadata is preserved, but ownership of the imported copy belongs to the importing user on the new instance.

## Orphaned Blueprints

A blueprint can outlive its source gadget. If a gadget is deleted, its blueprints remain accessible via KV and R2. The user can manage orphaned blueprints through `AuthenticatedApi.listOwnBlueprints()` (which reads from the User DO) and delete them via `deleteOrphanedBlueprint()` (which cleans up KV, R2, and the User DO record directly, bypassing the now-deleted Gadget DO).

## Creation Specs

To support blueprint metadata derivation, each gatekeeper stores a `GatekeeperCreationSpec` that records how it was originally created. This includes the vendor ID (for gatekeeper bindings), provider and model name (for AI model bindings), or the full spawner config (for agent spawner bindings). The creation spec, combined with the blueprint annotation, is used by `collectBindingMetadata` to produce the `BlueprintBinding` records stored in the blueprint.
