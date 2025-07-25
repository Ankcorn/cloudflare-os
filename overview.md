# AI Minions

This repository defines the core architecture behind the AI Minions product.

# Product Description

The product is a platform for building and deploying personal web applications, called "AI Minions". A Minion is an application built on Cloudflare Workers, but with some special properties:
* A Minion is typically specialized to the needs of a specific individual or team, like to help someone automate part of their job that isn't handled by more general software.
* A Minion is typically coded with AI assistance. The human author may not know how to code themselves, or may not have time to write the code by hand. So, they instead describe what they want to an AI, which writes the code for them.
* A user may have many Minions. They can freely create new ones, as easily as creating a new document in Google Docs. The main UI shows a list of the user's minions, letting them click on one to open it and modify or interact with it.

## Minion code

* Since Minions are built on Workers, the actual code of a Minion is JavaScript code just like you'd write in a Worker. Unlike regular Workers, though, Minions do not have access to the internet. They can only interact with the world through their bindings (the contents of the `env` object) which are configured by the Minion's owner.
* Typically, these bindings would NOT be traditional Workers bindings (like Workers KV, Hyperdrive, etc.) but instead would be bindings representing the company's internal systems. For example, a Minion might have a Jira binding, allowing them to file tickets in Jira, or a chat binding, allowing the Minion to send and receive messages through corporate chat. You can see how these bindings would be useful in building automations for everyday workflows.
* Minion bindings are intended to enforce exactly what a Minion is allowed to do. For example, it's unlikely that a Minion would actually get a Jira binding that lets it do whatever a human could do in Jira. Instead, it would receive a binding allowing only very specific actions, like "Ability to create new tickets under the XYZ project in Jira".
* Concretely, each Minion is a singleton Durable Object. So, the code structure defines a Durable Object class. The class inherits the base class `Minion` instead of `DurableObject`, but `Minion` works exactly the same as `DurableObject`. This means each Minion has access to private storage via `this.ctx.storage` (including SQLite storage at `this.ctx.storage.sql`).
* The Durable Object may export methods that represent functions that the owner can directly invoke via the Minion's management UI, either directly via a JavaScript REPL interface, or by asking an AI assistant to help.
* A Minion can optionally implement a UI. The UI is a single-page app that runs in an iframe sandbox which prohibits it from talking to anything except the Minion's server. The platform automatically sets up an RPC connection between the iframe and the Minion's server, allowing it to invoke methods on the Minion class.

## Code editing

* The Minion's owner can open a code editor for the Minion.
* This opens an in-browser IDE with an agentic AI assistant.
* The AI assistant is represented by a chat window that sits adjacent to the code editor window.
* The AI assistant is configured with "tools" allowing it to read and modify the code, run tests, view errors, etc.
* Whenever the AI modifies code or performs other actions that have side effects, the user is prompted to approve or reject the change.
* The user can, of course, edit code directly, if they like.
* The editor features a UI for adding bindings, which are called "connections", because they "connect" the minion to external resources.
* The editor automatically tracks the complete history of all edits ever made, including every keystroke typed and all AI chat conversations. The user (or the AI agent) can review the history and revert to old versions if desired.
* The editor features a testing workbench, where the Minion can execute in a mode where some or all bindings are simulated. Each binding comes with a simulator implementation intended to plug into this environment. The simulator will display a UI frame that helps the user interactively view what the Minion is doing with the binding and arrange simulated responses. For example, a simulator for a chat binding would render a mock chat room where the user can see the Minion post messages, can reply to them, etc. That said, the user can choose instead to run tests using the real bindings, if they prefer. The testing workbench also features a JavaScript console, similar to Chrome's devtools. (It may actually be based on the same code as Chrome's devtools.)

## Sharing

* A Minion is by default only accessible by its creator.
* However, the Minion's owner can share the Minion with other users, similar to sharing a Google Doc.
* Each user may be assigned different permissions. The Minion's code defines what permissions exist. RPC methods exposed on the Minion's Durable Object can be annotated with the required permission to call that method.
* Some permissions are defined as "read-only". If a user has only read-only permissions, then when they access the Minion, they'll actually be accessing a replica of the Minion which enforces that the user can't perform any actions with side effects.
* The owner may also choose to give other users permission to edit the Minion's code directly. Such permission implies all other permissions, since the recipient can of course bypass all other permissions anyway by editing the code.

## Blueprints

* A user may create a "blueprint" from an existing Minion, which captures its current code.
* A blueprint can be used to create more Minions based on the same code.
* Blueprints can be shared with other users.
* A blueprint does *not* capture the Minion's bindings – only the types of the bindings. When a new Minion is created from a blueprint, the user must configure its bindings, matching the types. This is particularly important since different Minions – even based on the same blueprint – may be intended to interact with different resources. For instance, if you had a Minion that implements a chat bot, and many different teams want to use the same chat bot, each team would likely configure their own copy of the Minion with a binding that points to the team's own chat channel.
* A blueprint also does *not* capture the content of the Minion's storage (`this.ctx.storage`).
* Sometimes even a single user wants many copies of a Minion. For example, imagine a Minion which implements some sort of document editor. The user may want to create many documents. Instead of having one Minion that handles all the docs, the better design is to build a Minion that handles just one document, and then make many copies of that Minion. This way, each Minion can potentially be shared with different users, depending on who should be allowed to see the specific document.
* The creator of a blueprint may update it over time. Other users of the blueprint can choose whether to automatically apply updates to their own Minions or whether to stay pinned to a specific version.
* Users can clone a blueprint, like forking a git repo, in order to start making their own changes. They can optionally transition their existing Minions from the original blueprint to the clone.

# Security Model

Minions implement a novel security model that makes them safe to run even when the code may be buggy. The Minions platform enforces security in such a way that bugs in Minion code cannot cause security problems.

## Fundamentals

The basic idea behind the security model is: A user shall not be allowed to create or interact with a Minion that has any capability that the human user themself lacks. Hence, a Minion never enables a human to do something that the human couldn't have done directly.

When a Minion does something that may have visible side effects (as opposed to simply reading information), we call this an "Action". All actions may be subject to human approval. Security policies configured by the user (or their corporate security team) determine which actions must be approved explicitly.

In more detail:
* If a Minion can read information that has restricted access, then any user who is not able to read that information will also be prohibited from interacting with the Minion, to prevent data leaks.
* A Minion has a set of "influencers", defined as the set of people who can either directly access the Minion (with non-read-only permissions) or can write to locations that the Minion can see. If the Minion is capable of performing actions that one or more influencers are not directly capable of, then actions may require increased scrutiny, to prevent malicious influencers from tricking the Minion into performing restricted actions on their behalf.
* When a Minion performs an action that can be observed by others, if the set of people that can observe the action includes people who cannot directly read all of the Minion's input information, then the action may require increased scrutiny, to prevent data leaks.
* Actions are also classified by whether they strictly create new information (e.g. posting a new ticket to Jira) vs. editing existing information (changing the status of an existing ticket), and this also affects the level of scrutiny an action needs.
* All actions are logged in an audit log.

## Adapters

* As mentioned above, Minions can only access the outside world via explicit bindings.
* "Adapters" are implementations of bindings specifically designed to be used by Minions. Every Minion binding must be supported by an adapter.
* Adapters are also built as Cloudflare Workers.
* An adapter implements a JavaScript RPC interface which the Minion can call, backed by whatever API the adapted service supports (e.g. an OAuth / REST API).
* Adapters do more than just adapt the API, though. They also adapt the security model, defining fine-grained permissions and policies to support the Minions security rules.
* Adapters are responsible for submitting all actions to an approval queue and waiting for approval before carrying out the action.

# Runtime architecture

A Minion executes as part of a Durable Object. Unlike a regular Durable Object, this object is made up of multiple Workers working together: The Minion, an Overseer, and one or more Gatekeepers.

* The Minion is the code created by the user.
* The Overseer supervises the Minion. All incoming requests first go to the Overseer, which decides whether they are authorized before forwarding them to the Minion.
* The Gatekeepers implement each of the Minion's bindings, each of which provides access to one external resource. The code for each Gatekeeper is provided by its respective Adapter.

## Overseer details

The overseer's code is part of the Minion platform itself.

Overseers are, in fact, regular old Durable Objects. The Minion platform implements the Overseer object and routes Minion traffic to its Overseer.

The Overseer uses a Workers for Platforms dispatcher binding to dispatch to the Minion code. This is a new feature in Workers for Platforms, allowing a request to be dispatched to another Worker which runs as a component of the very same Durable Object. Using this feature, the dispatched-to Minion gets direct access to its own private section of the DO's storage. Specifically, the Minion receives its own SQLite database. Hence, the Durable Object actually contains multiple SQLite databases: one for the Overseer and one for the Minion.

The Gatekeepers, too, work similarly to the Minion. The Overseer uses a Workers for Platforms dispatcher to instantiate the appropriate Gatekeeper to implement each binding. Each Gatekeeper also gets its own private storage.

## Gatekeeper details

When the Overseer instantiates a Gatekeeper, it calls the Gatekeeper's startSession() method, which returns an RPC object that represents the binding which should be given to the Minion.

startSession() takes, as a parameter, a callback which the Gatekeeper must use to request approval for actions requested by the Minion. An "action" is anything the Minion asks the Gatekeeper to do which has observable side-effects (as opposed to read-only queries). Each action must be submitted for approval. Depending on policy, actions might be auto-approved, or they might require human approval; the Overseer manages this.
