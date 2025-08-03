# AI Minions

This repository defines the core architecture behind the AI Minions product.

# Product Description

## What?

The product is a platform for building and deploying personal AI assistants, called "AI Minions". A Minion is a special kind of AI agent with some specific properties:

* It can connect to external APIs and resources in a way that enforces strict security policies that simultaneously allow access to sensitive data while preventing the Minion from doing anything bad.

* It can write code to automate tasks. The code runs in an isolated sandbox where it can only talk to the resources to which the Minion has been connected.

* A user may have many Minions. They can freely create new ones, as easily as creating a new document in Google Docs. Each Minion has different permissions, to handle different tasks in isolation. Minion code can be cloned and shared, in order to perform the same task on different resources without leaking context between them.

## Why?

AI Minions are a combined agentic AI assistant and vibe coding platform which solves security problems inherent to both.

We all want AI to be able to automate tasks for us to make us more productive. However, in order to perform useful tasks, AI needs to connect to our private (personal or corporate) data and potentially perform sensitive tasks on our behalf.

This presents a security problem. Consider an AI agent which can read all your email, and which is tasked with responding to individual emails. How can you prevent this agent from replying to one email in a way that reveals secrets it learned from another email? Especially in the face of malicious emails containing prompt injection attacks?

Much of the industry seems focused on the answer: "We'll use careful training and prompt engineering to get the AI to do the right thing. Eventually AI will be smart enough that it'll never screw up."

AI minions has a different answer: Create separate, isolated copies of the Minion to handle each and every email. Each Minion only ever sees the email it is meant to reply to, so it necessarily cannot leak data. Using this approach, we can often guarantee that a Minion can't possibly leak data or enable privilege escalation, no matter what code it contains or what the agent decides to do.

## How?

AI Minions is built on Cloudflare Workers, Durable Objects, and Workers AI.

The main UI through which users create and interact with Minions is called the Minion Workshop. In addition to providing the UI, the Workshop implements an "Overseer" for each Minion which monitors it and enforces security policies on it.

Every Minion starts as a simple AI agent that is not connected to anything. Upon creating a Minion, the user starts out with a typical AI LLM chat window. But from there, a few interesting things can happen:

* The agent can write code to implement repeatable tasks. This code is written in TypeScript, implementing a Cloudflare Workers Durable Object. This code appears in an editor window where the user can directly read and edit it if they want, although they can also rely on the agent to do all the editing. The agent can directly invoke RPC methods exported by this Durable Object. The DO starts out completely isolated from the world -- it is not allowed to invoke global fetch() or connect() to talk to the internet.

* The agent can also write code to implement a custom UI for the Minion. This code is also written in TypeScript, but runs in the browser. Minion UI code runs in an iframe sandbox that totally prevents it from talking to anything, except postMessage() to the parent frame. Through such postMessage()s, it can speak RPC back to the Minion's Durable Object.

* The user can connect the agent to external resources that they want the agent to manipulate. Each connection is exposed both to the agent for direct use, and to the application code as an `env` binding providing an RPC interface to the resource. Each connection is governed by a "Gatekeeper", a component which understands the specific type of resource. The Gatekeeper implements the RPC interface, enforcing security policies on it, in collaboration with the Overseer.

* Any actions performed by the Minion that alter the external resources to which it is connected will be logged, and may be subject to explicit approval by the user. The Overseer is able to implement powerful security policies that help flag possibly-dangerous actions, helping the user understand what needs careful review. For example, if the Minion has access to a sensitive document that few users have access to, and the Minion is trying to post information somewhere where it can be seen by a wider audience, this may trigger additional review or outright rejection of the action due to the risk of data leaks.

* The Minion can also be assigned to handle a large collection of resources by creating a clone to handle each resource. This can include handling future resources as they are created, or when some event takes place that needs attention.

# UI details

## Workshop Home

The Workshop UI's home page lists the user's minions. This looks similar to the Google Drive home page. The user can open a minion, or create a new one.

## Minion Editor

The Minion editor has four main components:

* A chat log with the AI agent (LLM). (When a new Minion is created, initially this is all there is.)

* A code editor, for editing the Minion's Durable Object code. While it's expected that users will usually prompt the AI agent to write code for them, the user is free to edit the code directly, and the code editor has the usual affordances of a modern IDE, like syntax highlighting, auto-complete, and jump-to-definition.

* The Overseer UI. Whenever the Minion performs actions that have side effects, those actions are logged here. The user can use this UI to see what the Minion is doing, to approve actions that require explicit approval, and to revert actions after the fact. This UI also shows the list of external connections the Minion currently has access to, allowing the user to edit their permissions or revoke them entirely.

* The Minion's own UI, if it has one. The Minion can implement a UI for itself as part of its code. This UI runs in a sandboxed iframe on the client, where it is completely isolated from everything except RPC-over-postMessage() to the parent frame. Though that RPC link, the Minion's UI can talk to its own server-side code.

## Adding connections

When the user pastes a URL into the chat window, the Workshop automatically prompts the user to decide what sort of access the Minion should receive to this URL.

The Workshop will search from among available Gatekeeper implementations for one that claims to handle the URL. (If none is found, a default Gatekeeper that merely provides the ability to fetch the web site may be used.)

The Workshop instantiates the Gatekeeper and displays to the user basic information about the resource, so that the user can verify they are connecting to the right thing. (If the user has never used this Gatekeeper before, the Workshop may need to direct the user to an OAuth flow to grant access -- this grants the Workshop itself access to the given service on behalf of the user, but does NOT grant permissions to a specific Minion.)

Once the user submits the chat message to the AI agent containing a resource URLs, the Gatekeeper is then exposed to the Minion. The agent can query its schema to learn what operations it provides and what permissions are required for each operation. The agent is then able to decide what particular permissions it needs, and can request those permissions. When it does so, the user is presented with a prompt rendered inline within the chat, outlining what permissions are requested, and asking them to approve or deny the request. The user can also open an advanced dialog in which they can specify which actions should require human-in-the-loop approval when used.

Once a connection made and permissions are set, the agent can use the connection directly via tool calls, and the connection can also be invoked by the Minion's code as an `env` binding exposing an RPC interface.

## Editing code

The code editor not only shows the current state of the code, but maintains a complete history of all individual changes made to the code, and who made them (human or agent). There is no need for the user to explicitly signal when to commit changes -- the history is recorded continuously, like a Google Docs edit history. Users are not prompted to accept or reject each change proposed by the agent, but can easily review and revert changes via the editor UI. (Also like Google Docs, all changes are saved duably immediately as the keystrokes are made, so nothing is lost if the user's browser crashes.)

All changes made to the code do not immediately go live. The user must "commit" the changes first. This ensures that the user has a chance to review and test changes before they go live, if they want.

The user can execute code that hasn't been saved yet. Such code will be executed in "test mode", where any actions performed through the Minion's bindings will not be applied, only logged. The user can then review to make sure it did the right things.

## Sharing

A Minion is by default only accessible by its creator. However, the Minion's owner can share the Minion with other users, similar to sharing a Google Doc.

The owner can assign one of the following roles to each person they share with:
* Developer: Can fully access the Minion including talking to the Minion's agent and editing code.
* Operator: Can use the Minion's sandboxed UI, including functions that cause it to perform actions on its connections.
* Observer: Can view the Minion's sandboxed UI in read-only mode. This is accomplished by spawning a fork of the Minion's Durable Object which is unable to modify its storage nor perform any side-effecting actions on connections.

## Blueprints

A user may create a "blueprint" from an existing Minion, which captures its current code, but not edit history nor AI chat logs. A blueprint can be used to create more Minions based on the same code. Blueprints can also be shared with other users.

A blueprint does *not* capture the Minion's connections – only the types of the connections. When a new Minion is created from a blueprint, the user must specify new resources to connect to, with matching types. This is particularly important since different Minions – even based on the same blueprint – may be intended to interact with different resources. For instance, if you had a Minion that implements a chat bot, and many different teams want to use the same chat bot, each team would likely configure their own copy of the Minion with a binding that points to the team's own chat channel.

A blueprint also does *not* capture the content of the Minion's SQLite storage (`this.ctx.storage`).

Sometimes even a single user wants many copies of a Minion. For example, imagine a Minion which implements some sort of document editor. The user may want to create many documents. Instead of having one Minion that handles all the docs, the better design is to build a Minion that handles just one document, and then make many copies of that Minion. This way, each Minion can potentially be shared with different users, depending on who should be allowed to see the specific document.

The creator of a blueprint may update it over time. Other users of the blueprint can choose whether to automatically apply updates to their own Minions or whether to stay pinned to a specific version.

When a Minion is created from a blueprint initially, modified, and then used to create a new blueprint, the new blueprint is a "fork" of the original. The user can optionally transition other Minions they have that started from the original blueprint to use the fork instead.

# Security Model

Minions implement a novel security model that makes them safe to run even when the code may be buggy. The Minions platform enforces security in such a way that bugs in Minion code cannot cause security problems.

## Fundamentals

The basic idea behind the security model is: A user shall not be allowed to create or interact with a Minion that has any capability that the human user themself lacks. Hence, a Minion never enables a human to do something that the human couldn't have done directly.

When a Minion does something that may have visible side effects (as opposed to simply reading information), we call this an "Action". All actions may be subject to human approval. Security policies configured by the user (or their corporate security team) determine which actions must be approved explicitly.

In more detail:

* If a Minion can read information that has restricted access, then any user who is not able to read that information will also be prohibited from interacting with the Minion, to prevent data leaks.

* A Minion has a set of "influencers", defined as the set of people who can either directly access the Minion (with non-read-only permissions) or can write to locations that the Minion can see. If the Minion is capable of performing actions that one or more influencers are not directly capable of, then actions may require increased scrutiny, to prevent malicious influencers from tricking the Minion into performing restricted actions on their behalf (e.g. using prompt injection). The simplest form of scrutiny is to require that all actions be reviewed and approved by an appropriate human, although this may be heavy-handed, so the Workshop administrator (e.g. corporate security team) may configure more nuanced policies depending on the details.

* When a Minion performs an action that can be observed by others, if the set of people that can observe the action includes people who cannot directly read all of the Minion's input information, then the action may require increased scrutiny, to prevent data leaks.

* Actions are also classified by whether they strictly create new information (e.g. posting a new ticket to Jira) vs. editing existing information (changing the status of an existing ticket), as well as whether the information created contains arbitrary text content vs. merely state changes. These properties may affect the level of scrutiny needed.

* All actions are logged in an audit log, whether or not they require approval.

## Gatekeepers

As mentioned above, Minions can only access the outside world via explicit bindings.

"Gatekeepers" are implementations of bindings specifically designed to be used by Minions. Every Minion binding must be supported by a Gatekeeper. Gatekeepers are also built as Cloudflare Workers.

A Gatekeeper implements a JavaScript RPC interface which the Minion can call, backed by whatever API the adapted service supports (e.g. an OAuth / REST API). Gatekeepers do more than just adapt the API, though. They also adapt the security model, defining fine-grained permissions and policies to support the Minions security rules. Gatekeepers are also responsible for submitting all actions to an approval queue and waiting for approval before carrying out the action.

# Runtime architecture

A Minion executes as part of a Durable Object. Unlike a regular Durable Object, this object is made up of multiple Workers working together: The Minion, an Overseer, and one or more Gatekeepers.

* The Minion is the code written by the agent (or the user).

* The Overseer supervises the Minion. All incoming requests first go to the Overseer, which decides whether they are authorized before forwarding them to the Minion.

* The Gatekeepers implement each of the Minion's bindings, each of which provides access to one external resource. The code for each Gatekeeper is provided by its respective Adapter.

## Overseer details

The overseer's code is part of the Minion platform itself.

Overseers are, in fact, regular old Durable Objects. The Minion platform implements the Overseer object and routes Minion traffic to its Overseer.

The Overseer uses a [Dynamic Worker Loader](https://github.com/cloudflare/workerd/pull/4383) to load the Minion's code, and then instantiates a [Durable Object Facet](https://github.com/cloudflare/workerd/pull/4123) based on the code. (As of this writing, these features are experimental.) This gives the Minion access to its own SQLite database which is separate from the Overseer's, but stored alongside it, as part of the same Durable Object.

Similarly, the Overseer instantiates each Gatekeeper as a facet. The Gatekeepers, though, are not dynamically-loaded, but rather implemented by separate Workers to which the Overseer is connected via service bindings.

## Gatekeeper details

When the Overseer instantiates a Gatekeeper, it calls the Gatekeeper's startSession() method, which returns an RPC object that represents the binding which should be given to the Minion.

startSession() takes, as a parameter, a callback which the Gatekeeper must use to request approval for actions requested by the Minion. An "action" is anything the Minion asks the Gatekeeper to do which has observable side-effects (as opposed to read-only queries). Each action must be submitted for approval. Depending on policy, actions might be auto-approved, or they might require human approval; the Overseer manages this.
