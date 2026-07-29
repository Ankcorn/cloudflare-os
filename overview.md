# AI Gadgets

This repository defines the core architecture behind the AI Gadgets product.

# Product Description

## What?

The product is a platform for building and deploying personal AI assistants, called "AI Gadgets". A Gadget is a special kind of AI agent with some specific properties:

* It can connect to external APIs and resources in a way that enforces strict security policies that simultaneously allow access to sensitive data while preventing the Gadget from doing anything bad.

* It can write code to automate tasks. The code runs in an isolated sandbox where it can only talk to the resources to which the Gadget has been connected.

* A user may have many Gadgets. They can freely create new ones, as easily as creating a new document in Google Docs. Each Gadget has different permissions, to handle different tasks in isolation. Gadget code can be cloned and shared, in order to perform the same task on different resources without leaking context between them.

## Why?

AI Gadgets are a combined agentic AI assistant and vibe coding platform which solves security problems inherent to both.

We all want AI to be able to automate tasks for us to make us more productive. However, in order to perform useful tasks, AI needs to connect to our private (personal or corporate) data and potentially perform sensitive tasks on our behalf.

This presents a security problem. Consider an AI agent which can read all your email, and which is tasked with responding to individual emails. How can you prevent this agent from replying to one email in a way that reveals secrets it learned from another email? Especially in the face of malicious emails containing prompt injection attacks?

Much of the industry seems focused on the answer: "We'll use careful training and prompt engineering to get the AI to do the right thing. Eventually AI will be smart enough that it'll never screw up."

AI gadgets has a different answer: Create separate, isolated copies of the Gadget to handle each and every email. Each Gadget only ever sees the email it is meant to reply to, so it necessarily cannot leak data. Using this approach, we can often guarantee that a Gadget can't possibly leak data or enable privilege escalation, no matter what code it contains or what the agent decides to do.

## How?

AI Gadgets is built on Cloudflare Workers, Durable Objects, and Workers AI.

The main UI through which users create and interact with Gadgets is called the Gadget Workshop. In addition to providing the UI, the Workshop implements an "Overseer" for each Gadget which monitors it and enforces security policies on it.

Every Gadget starts as a simple AI agent that is not connected to anything. Upon creating a Gadget, the user starts out with a typical AI LLM chat window. But from there, a few interesting things can happen:

* The agent can write code to implement repeatable tasks. This code is written in TypeScript, implementing a Cloudflare Workers Durable Object. This code appears in an editor window where the user can directly read and edit it if they want, although they can also rely on the agent to do all the editing. The agent can directly invoke RPC methods exported by this Durable Object. The DO starts out completely isolated from the world -- it is not allowed to invoke global fetch() or connect() to talk to the internet.

* The agent can also write code to implement a custom UI for the Gadget. This code is also written in TypeScript, but runs in the browser. Gadget UI code runs in an iframe sandbox that totally prevents it from talking to anything, except postMessage() to the parent frame. Through such postMessage()s, it can speak RPC back to the Gadget's Durable Object.

* The user can connect the agent to external resources that they want the agent to manipulate. Each connection is exposed both to the agent for direct use, and to the application code as an `env` binding providing an RPC interface to the resource. Each connection is governed by a "Gatekeeper", a component which understands the specific type of resource. The Gatekeeper implements the RPC interface, enforcing security policies on it, in collaboration with the Overseer.

* Any actions performed by the Gadget that alter the external resources to which it is connected will be logged, and may be subject to explicit approval by the user. The Overseer is able to implement powerful security policies that help flag possibly-dangerous actions, helping the user understand what needs careful review. For example, if the Gadget has access to a sensitive document that few users have access to, and the Gadget is trying to post information somewhere where it can be seen by a wider audience, this may trigger additional review or outright rejection of the action due to the risk of data leaks.

* The Gadget can also be assigned to handle a large collection of resources by creating a clone to handle each resource. This can include handling future resources as they are created, or when some event takes place that needs attention.

# UI details

## Workshop Home

The Workshop UI's home page is a launcher for creating a new Gadget: it presents a prompt composer where the user writes the first message to a new Gadget's agent, alongside suggested tasks. The user's existing Gadgets — labeled "workspaces" in the UI — are listed in a persistent sidebar and on a dedicated workspaces page (similar to the Google Drive home page), from which the user can reopen any of them.

## Gadget Editor

The Gadget editor is split between a chat log on the left and a tabbed panel on the right. Its main components are:

* A chat log with the AI agent (LLM). (When a new Gadget is created, initially this is all there is.)

* A code editor, for editing the Gadget's Durable Object code. While it's expected that users will usually prompt the AI agent to write code for them, the user is free to edit the code directly, and the code editor has the usual affordances of a modern IDE, like syntax highlighting, auto-complete, and jump-to-definition.

* The Activity tab. Whenever the Gadget performs actions that have side effects, those actions are logged here. The user can use this tab to see what the Gadget is doing, to approve actions that require explicit approval, and to revert actions after the fact.

* The Connections tab, which shows the list of external connections the Gadget currently has access to, allowing the user to edit their permissions or revoke them entirely.

* The Gadget's own UI, if it has one. The Gadget can implement a UI for itself as part of its code. This UI runs in a sandboxed iframe on the client, where it is completely isolated from everything except RPC-over-postMessage() to the parent frame. Though that RPC link, the Gadget's UI can talk to its own server-side code.

## Adding connections

When the user includes a URL in a chat message, the Workshop automatically prompts the user to turn it into a "capsule": a connection granting the Gadget some form of access to the resource at that URL. The Workshop will search from among available Gatekeeper implementations for one that claims to handle the URL.

The Workshop instantiates the Gatekeeper and displays to the user basic information about the resource, so that the user can verify they are connecting to the right thing. (If the user has never used this Gatekeeper before, the Workshop may need to direct the user to an OAuth flow to grant access -- this grants the Workshop itself access to the given service on behalf of the user, but does NOT grant permissions to a specific Gadget.)

The user can also manage connections outside of chat. The Workshop has a Connectors page where the user connects reusable *accounts* to third-party services (typically via OAuth) once, then draws on them across many Gadgets; when adding a binding, the Workshop shows a UI supplied by the Gatekeeper to guide the user through selecting a specific resource. Some Gatekeepers auto-provision an account with no OAuth flow at all — for these, the deployment administrator chooses whether the connector is offered to users, forced on for everyone, or disabled.

Once the user submits the chat message to the AI agent containing a resource URL, the Gatekeeper is then exposed to the Gadget. The agent can query its schema to learn what operations it provides and what permissions are required for each operation. The agent is then able to decide what particular permissions it needs, and can request those permissions. When it does so, the user is presented with a prompt rendered inline within the chat, outlining what permissions are requested, and asking them to approve or deny the request. The user can also open an advanced dialog in which they can specify which actions should require human-in-the-loop approval when used.

Once a connection is made and permissions are set, the agent can use the connection directly via tool calls, and the connection can also be invoked by the Gadget's code as an `env` binding exposing an RPC interface.

## Editing code

The code editor not only shows the current state of the code, but maintains a complete history of all individual changes made to the code, and who made them (human or agent). There is no need for the user to explicitly signal when to commit changes -- the history is recorded continuously, like a Google Docs edit history. Users are not prompted to accept or reject each change proposed by the agent, but can easily review and revert changes via the editor UI. (Also like Google Docs, all changes are saved durably immediately as the keystrokes are made, so nothing is lost if the user's browser crashes.)

When the user is viewing a particular chat thread, direct edits in the code editor are applied to that thread's proposed-changes branch rather than immediately affecting the mainline code. This allows the user and agent to collaborate within a thread on the same pending branch state, and the agent is informed about user-authored edits through synthetic `observeUserChanges` events in the chat history.

All changes made to the code do not immediately go live. The user must "commit" the changes first. This ensures that the user has a chance to review and test changes before they go live, if they want.

The user can execute code that hasn't been saved yet. Such code will be executed in "test mode", where any actions performed through the Gadget's bindings will not be applied, only logged. The user can then review to make sure it did the right things.

## Sharing

A Gadget is by default only accessible by its creator. However, the Gadget's owner can share the Gadget with other users, similar to sharing a Google Doc — either by adding a user directly or by creating a share link. Collaborators can work in the same Gadget simultaneously, and can see each other's presence live.

The owner can assign one of the following roles to each person they share with:
* `build`: Can fully access the Gadget including talking to the Gadget's agent and editing code.
* `use`: Can use the Gadget's sandboxed UI, including functions that cause it to perform actions on its connections.
* `view`: Can view the Gadget's sandboxed UI in read-only mode. This is accomplished by spawning a fork of the Gadget's Durable Object which is unable to modify its storage nor perform any side-effecting actions on connections.

When a collaborator (with `build` access) uses AI chat or adds a binding, it draws on *their own* AI models and connected accounts, not the owner's — so a collaborator never gains access to the owner's accounts beyond what the Gadget's existing bindings already expose.

All collaborators (with any access level) are treated as "observers" of the gadget's data. Each observer must prove that they have permission to read all the underlying data that the gadget itself has read, from all of its backends, in order to access the gadget. This ensures that a gadget cannot leak secrets that its users would not be permitted to access directly.

## Blueprints

A user may create a "blueprint" from an existing Gadget, which captures its current code, but not edit history nor AI chat logs. A blueprint can be used to create more Gadgets based on the same code. Blueprints can be shared directly with other users, published to a gallery that others can explore, or exported to and imported from `.gadget` files.

A blueprint does *not* capture the Gadget's connections – only the types of the connections. When a new Gadget is created from a blueprint, the user must specify new resources to connect to, with matching types. This is particularly important since different Gadgets – even based on the same blueprint – may be intended to interact with different resources. For instance, if you had a Gadget that implements a chat bot, and many different teams want to use the same chat bot, each team would likely configure their own copy of the Gadget with a binding that points to the team's own chat channel.

A blueprint also does *not* capture the content of the Gadget's SQLite storage (`this.ctx.storage`).

Sometimes even a single user wants many copies of a Gadget. For example, imagine a Gadget which implements some sort of document editor. The user may want to create many documents. Instead of having one Gadget that handles all the docs, the better design is to build a Gadget that handles just one document, and then make many copies of that Gadget. This way, each Gadget can potentially be shared with different users, depending on who should be allowed to see the specific document.

The creator of a blueprint may update it over time. Other users of the blueprint can choose whether to automatically apply updates to their own Gadgets or whether to stay pinned to a specific version.

When a Gadget is created from a blueprint initially, modified, and then used to create a new blueprint, the new blueprint is a "fork" of the original. The user can optionally transition other Gadgets they have that started from the original blueprint to use the fork instead.

## Deployment administration

The Workshop is a multi-tenant deployment that an administrator operates for a group of users. Administrators have an admin panel where they can customize the deployment: the agent's instructions, branding/theme, and announcement banners; which Gatekeeper connectors and resources are offered to users (including the three-state mode for auto-provisioning connectors described above); and which blueprints are featured. Sign-in providers and whether password login is allowed are configured separately, through deployment environment variables rather than the admin panel, so that they cannot be changed by a compromised admin session.

# Security Model

Gadgets implement a novel security model that makes them safe to run even when the code may be buggy. The Gadgets platform enforces security in such a way that bugs in Gadget code cannot cause security problems.

## Fundamentals

The basic idea behind the security model is: A user shall not be allowed to create or interact with a Gadget that has any capability that the human user themself lacks. Hence, a Gadget never enables a human to do something that the human couldn't have done directly.

When a Gadget does something that may have visible side effects (as opposed to simply reading information), we call this an "Action". All actions may be subject to human approval. Security policies configured by the user (or their corporate security team) determine which actions must be approved explicitly.

In more detail:

* If a Gadget can read information that has restricted access, then any user who is not able to read that information will also be prohibited from interacting with the Gadget, to prevent data leaks.

* A Gadget has a set of "influencers", defined as the set of people who can either directly access the Gadget (with non-read-only permissions) or can write to locations that the Gadget can see. If the Gadget is capable of performing actions that one or more influencers are not directly capable of, then actions may require increased scrutiny, to prevent malicious influencers from tricking the Gadget into performing restricted actions on their behalf (e.g. using prompt injection). The simplest form of scrutiny is to require that all actions be reviewed and approved by an appropriate human, although this may be heavy-handed, so the Workshop administrator (e.g. corporate security team) may configure more nuanced policies depending on the details.

* When a Gadget performs an action that can be observed by others, if the set of people that can observe the action includes people who cannot directly read all of the Gadget's input information, then the action may require increased scrutiny, to prevent data leaks.

* Actions are also classified by whether they strictly create new information (e.g. posting a new ticket to Jira) vs. editing existing information (changing the status of an existing ticket), as well as whether the information created contains arbitrary text content vs. merely state changes. These properties may affect the level of scrutiny needed.

* All actions are logged in an audit log, whether or not they require approval.

## Gatekeepers

As mentioned above, Gadgets can only access the outside world via explicit bindings.

"Gatekeepers" are implementations of bindings specifically designed to be used by Gadgets. Every Gadget binding must be supported by a Gatekeeper. Gatekeepers are also built as Cloudflare Workers.

A Gatekeeper implements a JavaScript RPC interface which the Gadget can call, backed by whatever API the adapted service supports (e.g. an OAuth / REST API). Gatekeepers do more than just adapt the API, though. They also adapt the security model, defining fine-grained permissions and policies to support the Gadgets security rules. Gatekeepers are also responsible for submitting all actions to an approval queue and waiting for approval before carrying out the action.

Not every binding is an external third-party service: the same Gatekeeper mechanism also provides bindings such as AI model access and the ability to spawn agents to perform tasks (essentially, starting chat threads with no human present).

A Gatekeeper account may additionally provide its own management UI, which appears in the nav sidebar of the workshop home page. For example, the scheduler gatekeeper handles scheduled tasks; the management UI allows the user to see all scheduled tasks across all gadgets and workspaces in one place.

Some Gatekeeper accounts provide a "singleton" that becomes ambiently available in every workspace automatically, without the user having to grant explicit permission. For example, the scheduler gatekeeper is available automatically, since scheduling tasks doesn't involve permission to any external resource.

# Runtime architecture

A Gadget executes as part of a Durable Object. Unlike a regular Durable Object, this object is made up of multiple Workers working together: The Gadget, an Overseer, and one or more Gatekeepers.

* The Gadget is the code written by the agent (or the user).

* The Overseer supervises the Gadget. All incoming requests first go to the Overseer, which decides whether they are authorized before forwarding them to the Gadget.

* The Gatekeepers implement each of the Gadget's bindings, each of which provides access to one external resource. The code for each Gatekeeper is provided by a separate Gatekeeper Worker (one per integrated service).

## Overseer details

The overseer's code is part of the Gadget platform itself.

Overseers are, in fact, regular old Durable Objects. The Gadget platform implements the Overseer object and routes Gadget traffic to its Overseer.

The Overseer uses a [Dynamic Worker Loader](https://github.com/cloudflare/workerd/pull/4383) to load the Gadget's code, and then instantiates a [Durable Object Facet](https://github.com/cloudflare/workerd/pull/4123) based on the code. (As of this writing, these features are experimental.) This gives the Gadget access to its own SQLite database which is separate from the Overseer's, but stored alongside it, as part of the same Durable Object.

Similarly, the Overseer instantiates each Gatekeeper as a facet. The Gatekeepers, though, are not dynamically-loaded, but rather implemented by separate Workers to which the Overseer is connected via service bindings.

## Gatekeeper details

When the Overseer instantiates a Gatekeeper, it calls the Gatekeeper's startSession() method, which returns an RPC object that represents the binding which should be given to the Gadget.

startSession() takes, as a parameter, a callback which the Gatekeeper must use to request approval for actions requested by the Gadget. An "action" is anything the Gadget asks the Gatekeeper to do which has observable side-effects (as opposed to read-only queries). Each action must be submitted for approval. Depending on policy, actions might be auto-approved, or they might require human approval; the Overseer manages this.
