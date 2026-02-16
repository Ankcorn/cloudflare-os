import { AiChatMessage, AiChatAuthorInfo, AiToolCall, AiChatMessageBody, AgentSpawnerConfig } from '@gadgets/workshop-shared/api';
import * as Y from "yjs";
import { generateText, hasToolCall, LanguageModel, ModelMessage, stepCountIs, tool, ToolCallPart, ToolResultPart, ToolSet } from "ai";
import z from "zod";

// Additional per-chat-thread info needed by the AI agent but not by the client.
export type AiChatAgentContext = {
  // Chat ID, corresponds to `chatMeta`.
  chatId: number;

  // If present, this chat was spawned using a spawner, and this was the spawner config at the
  // time.
  spawnerConfig?: AgentSpawnerConfig;

  // If present, the `ctx.props` value for use with `executeCode`.
  props?: unknown;
};

// Methods of OverseerImpl that runAgent() needs to call, extracted as an interface to avoid cyclic
// dependencies.
export interface AgentHooks {
  getChatAgentContext(chatId: number): AiChatAgentContext;
  buildYDoc(version: number | "current"): {ydoc: Y.Doc, version: number};
  listBindingNames(): string[];
  describeBinding(bindingName: string): Promise<string>;
  executeCodeMode(code: string, context: AiChatAgentContext): Promise<string>;
  addChatMessages(chatId: number, author: AiChatAuthorInfo, msgs: AiChatMessageBody[]): void;
}

let SYSTEM_PROMPT = `
You are a helpful coding assistant tasked with helping users write small personal applications known as "Gadgets". A Gadget is an application that typically serves a single user, or a small group, rather than being public-facing. They may help a user automate part of their job, or just be gadgets the user makes for fun.

Gadgets execute on a restricted and heavily-sandboxed variant of Cloudflare Workers.

A Gadget has two main files: client.js and server.js

server.js defines the Gadget's server-side logic, in the form of a Cloudflare Durable Object class. The class must be exported under the name \`Gadget\`. Unlike with normal Durable Objects on Cloudflare, there is no need to export a separate fetch handler; the Gadgets platform automatically takes care of routing requests to the Gadget. The Gadget has access to private storage via the regular Durable Objects KV and SQLite storage APIs. A simple server.js might look like:

\`\`\`
import { DurableObject } from "cloudflare:workers";

export class Gadget extends DurableObject {
  greet(name) {
    return \`Hello, \${name}!\`;
  }
}
\`\`\`

client.js is JavaScript that runs inside the browser to render a client-side user interface. This script runs inside a sandboxed iframe. It can display UI by manipulating the DOM. The client context is initialized with a special global variable called \`gadget\`, which is an RPC stub pointing at the gadget's Durable Object server. This RPC stub is implemented using Cap'n Web, an RPC system from Cloudflare that works similarly to Cloudflare Workers' built-in RPC system, but is able to be used in a browser. In short, methods invoked on the \`gadget\` stub will invoke the same-named method on the Durable Object class. A simple client.js might look like:

\`\`\`
let greeting = await gadget.greet("World");
document.body.appendChild(document.createTextNode(greeting));
\`\`\`

Note that there is no index.html. Instead, client.js must build the entire UI using JavaScript code.

Both the client and server run inside a strictly isolated sandbox. They cannot make requests to the Internet, e.g. by calling \`fetch()\`. Instead, a Gadget communicates with the outside world strictly through its "bindings", that is, the Cloudflare Workers \`env\` API, which code in the Durable Object class can access as \`this.env\`.

Note that Cap'n Web is a bidirectional object capability protocol, meaning, among other things, you can pass a function over RPC, in the params or results of another function. This actually passes the function "by reference": the receiving end actually receives an RPC stub, which can be used to call back over RPC to the original function. This, of course, causes the function to become async, even if the original was synchronous.

Using functions this way is a great way to implement real-time updates. The client can "subscribe" to updates, passing a callback function to the server. The server can then call the function asynchronously whenever the state changes (perhaps due to activity of a different client). This technique should be used when implementing multiplayer collaboration.

When implementing such a subscription, it is important to call \`.dup()\` on the callback stub, in order to obtain a long-lived stub. Otherwise, the stub received as a parameter is implicitly disposed at the end of the function. You should also use \`onRpcBroken\` to monitor for client disconnects, like:

\`\`\`
async subscribe(callback) {
  let callbackDup = callback.dup();
  this.subscribers.add(callbackDup);
  callbackDup.onRpcBroken(error => {
    this.subscribers.delete(callbackDup);
  });
}
\`\`\`

And on the client:

\`\`\`
function updateCallback(state) {
  // update the state
}

gadget.subscribe(updateCallback);
\`\`\`

NOTE: If you pass multiple callback functions to the server (e.g. wrapped in an object), each one must be \`dup()\`ed separately. Instead of doing that, consider writing a class that implements \`RpcTarget\`, which is a marker type from Cap'n Web that is automatically imported. Such a class can have multiple methods, but will be delivered to the server as a single stub with a single \`dup()\` method. Example:

\`\`\`
class Callbacks extends RpcTarget {
  update(state) { ... }
  reset() { ... }
}

gadget.subscribe(new Callbacks());
\`\`\`

Some general app design tips:
* ALWAYS store server state in Durable Object storage, not just in memory. Memory is OK to use for caching but users expect not to have their experience disrupted when the server restarts.
* If the user asks for a game or any sort of app where multiple users might collaborate, make sure multiple clients can connect at once and broadcast real-time updates to each other.
* Clients may frequently reload, and there is no client-side storage, so there is no way to track long-lived "sessions". So, for example, if the user asks for a multiplayer game, you should design it so that any connected client can choose to be any player. If it's turn-based, you can just let any client make any move. If it's concurrent but with distinct players, let each client choose which player they are controlling, including letting multiple clients choose the same player.
* If the project contains a README.md file, use it to describe the Gadget at a high level and document anything that future agents (or humans) may need to know when editing the code. You don't need to document details that are obvious from looking at the code, or which most people and agents would know already.
`.trim();

let SPAWNER_SYSTEM_PROMPT = `
You are an AI agent started to perform a specific task as part of a personal application called a "Gadget". A Gadget is an application that typically serves a single user, or a small group, rather than being public-facing. They may help a user automate part of their job, or just be gadgets the user makes for fun.

Gadgets execute on a restricted and heavily-sandboxed variant of Cloudflare Workers.

You were started programmatically by the Gadget to perform a task. The specific task will be described in the first message in this chat. The message is not directly from the user but rather from an automated system. If you receive any further messages after the first, then these additional messages are directly from a human user making additional requests regarding the task.

Typically (but not always), you will need to use the \`executeCode\` tool to complete the task, invoking the available bindings (members of the env object) and other APIs available to you.

Upon completion of your task, invoke the \`reportOutcome\` tool to indicate success or failure. One you have invoked the \`reportOutcome\` tool, you can end the conversation normally.
`.trim();

export async function runAgent(
    hooks: AgentHooks,
    chosenModel: LanguageModel,
    chatId: number,
    author: AiChatAuthorInfo,
    chatMessages: AiChatMessage[],
    abortSignal: AbortSignal): Promise<void> {
  // On first use, we'll build a copy of the Y.Doc, then reuse it for further tool calls in
  // this session.
  let ydoc: Y.Doc | undefined;
  let versionLock: number | undefined;
  let capturedYdocChanges: Uint8Array[] = [];
  let getSessionYDoc = () => {
    if (!ydoc) {
      let build = hooks.buildYDoc(versionLock === undefined ? "current" : versionLock);
      versionLock = build.version;
      ydoc = build.ydoc;

      ydoc.on("updateV2", (update, origin) => {
        capturedYdocChanges.push(update);
      });
    }
    return ydoc;
  };

  // Track which files have been read in this session. Edits aren't allowed before reading.
  let filesRead = new Set<string>();

  let modelMessages: ModelMessage[] = [];

  // Run through the chat log to process all "merge" and "revert" messages in order to mark
  // which messages lie in merged or reverted ranges. This serves two purposes:
  // 1. Let us know which changes should not be applied when building the Y.Doc of the current
  //    content.
  // 2. Let us know which *reads* are reading from reverted content, and therefore should be
  //    elided from the chat history for being no longer relevant.
  let chatMessageStatus: (undefined | "merged" | "reverted")[] = new Array(chatMessages.length);
  for (let msg of chatMessages) {
    if (msg.type === "merge") {
      for (let i = 0; i < msg.mergeThrough; i++) {
        if (chatMessageStatus[i] === undefined) {
          chatMessageStatus[i] = "merged";
        }
      }
    } else if (msg.type === "revert") {
      for (let i = msg.revertFrom; i < msg.sequence; i++) {
        if (chatMessageStatus[i] === undefined) {
          chatMessageStatus[i] = "reverted";
        }
      }
    }
  }

  // We compute sequential change ID numbers for the purpose of telling the LLM about reverts.
  let nextChangeId = 0;

  // Map sequence numbers to change IDs.
  let changeIdMap = new Map<number, number>();

  for (let msg of chatMessages) {
    switch (msg.type) {
      case "message": {
        let modelMessage: ModelMessage;
        switch (msg.author.type) {
          case "user":
            modelMessage = {
              role: "user",
              content: msg.message,
            };
            break;

          case "agent":
            modelMessage = {
              role: "assistant",
              content: msg.message,
            };
            break;

          default:
            msg.author.type satisfies never;
            continue;
        }

        modelMessages.push(modelMessage);

        if (msg.toolCalls) {
          let modelToolCalls: ToolCallPart[] = [];

          for (let toolCall of msg.toolCalls) {
            if (toolCall.observedCodeVersion !== undefined &&
                toolCall.observedCodeVersion !== versionLock) {
              if (versionLock === undefined) {
                versionLock = toolCall.observedCodeVersion;
              } else {
                throw new Error("observedCodeVersion version is inconsistent in chat history");
              }
            }

            // Recreate the tool output.
            // TODO: Refactor so that we're not duplicating tool implementations...
            let toolOutput: ToolResultPart["output"];
            try {
              if (toolCall.error) {
                toolOutput = {type: "error-text", value: `${toolCall.error}`};
              } else switch (toolCall.toolName) {
                case "readFile": {
                  if (chatMessageStatus[msg.sequence] === "reverted") {
                    // It would be a total waste of tokens to actually include this file
                    // content in the chat history since it contains changes that were later
                    // reverted -- not to mention a waste of resources to compute the content
                    // of the file. The agent can always read the current file contents if it
                    // needs to.
                    toolOutput = {
                      type: "error-text",
                      value: "This call succeeded when the agent first invoked it, but " +
                          "the reuslts have been elided from the chat history because " +
                          "the user later reverted the file to an earlier version."
                    };
                  } else {
                    let text = getSessionYDoc().getMap<Y.Text>().get(toolCall.input.filename);
                    if (!text) {
                      throw new Error("File does not exist.");
                    }
                    toolOutput = {
                      type: "text",
                      value: text.toString()
                    };
                    filesRead.add(toolCall.input.filename);
                  }
                  break;
                }
                case "writeFile":
                  toolOutput = {
                    type: "json",
                    value: {success: true, changeId: nextChangeId},
                  };
                  filesRead.add(toolCall.input.filename);
                  break;
                case "editFile":
                  toolOutput = {
                    type: "json",
                    value: {success: true, changeId: nextChangeId},
                  };
                  break;
                case "describeBinding":
                  toolOutput = {
                    type: "text",
                    value: await hooks.describeBinding(toolCall.input.bindingName),
                  };
                  break;
                case "executeCode":
                  toolOutput = {
                    type: "text",
                    value: toolCall.output!,
                  };
                  break;
                case "observeUserChanges":
                  toolOutput = {
                    type: "json",
                    value: {},
                  };
                  break;
                case "reportOutcome":
                  toolOutput = {
                    type: "json",
                    value: {acknowledged: true},
                  }
                  break;
                default:
                  toolCall satisfies never;
                  throw new Error("Unknown tool.");
              }
            } catch (err) {
              toolOutput = {type: "error-text", value: `${err}`};
            }

            modelMessages.push({
              role: "tool",
              content: [{
                type: "tool-result",
                toolName: toolCall.toolName,
                toolCallId: toolCall.toolCallId,
                output: toolOutput,
              }]
            });

            modelToolCalls.push({
              type: "tool-call",
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              input: toolCall.input,
            });
          }

          if (modelMessage.role === "assistant") {
            if (typeof modelMessage.content === "string") {
              modelMessage.content = [{type: "text", text: modelMessage.content}];
            }
            modelMessage.content = modelMessage.content.concat(modelToolCalls);
          }
        }

        break;
      }

      case "changes":
        if (chatMessageStatus[msg.sequence] !== "reverted") {
          Y.applyUpdateV2(getSessionYDoc(), msg.update);
        }
        changeIdMap.set(msg.sequence, nextChangeId);
        ++nextChangeId;
        break;

      case "merge":
        // No need to tell the agent about this.
        break;

      case "revert": {
        // Synthetic message.
        let toolCallId = `synthetic_${msg.sequence}`;
        modelMessages.push({
          role: "assistant",
          content: [{
            type: "tool-call",
            toolCallId,
            toolName: "observeUserChanges",
            input: {},
          }]
        });
        modelMessages.push({
          role: "tool",
          content: [{
            type: "tool-result",
            toolName: "observeUserChanges",
            toolCallId,
            output: {
              type: "json",
              value: {
                revertedFromChangeId: changeIdMap.get(msg.revertFrom)!,
              }
            },
          }]
        });
        break;
      }

      default:
        msg satisfies never;
        break;
    }
  }

  // Additional information noted during execution of tool calls which we want to merge into
  // the tool call logs later.
  //
  // As of this writing, if the tool call callback throws an error, the AI SDK renders the
  // error back to the LLM, but does NOT indicate an error in the `toolCalls` array it returns
  // to us. It only indicates an error there in cases where the AI failed to satisfy the
  // parameter schema, seemingly. So we have to catch our own errors and log them to the
  // side, ugh.
  let toolCallNotes = new Map<string, Partial<AiToolCall>>();

  capturedYdocChanges = [];

  let agentContext = hooks.getChatAgentContext(chatId);
  let systemPrompt: string;

  if (agentContext.spawnerConfig) {
    // This is a spawned agent. Build an appropriate system prompt.

    let systemPromptProps: string = "";
    let propsType = agentContext.spawnerConfig.propsTypeName;
    if (propsType && propsType !== "{}") {
      systemPromptProps =
          "\n\n"
          "You have been provided with a 'ctx.props' object which provides APIs that you likely " +
          "need to complete your task. This object is specific to the task you have been " +
          "assigned, as opposed to the env bindings which are given to every agent. The " +
          `ctx.props object has the following TypeScript type: ${propsType}`;

      let tsTypes = agentContext.spawnerConfig.propsTsTypes;
      if (tsTypes) {
        systemPromptProps += "\n\n" +
            "The ctx.props type refers to other TypeScript types. The following type definitions " +
            "have been provided to help you understand the type of ctx.props:\n\n" +
            "```\n" + tsTypes.trim() + "\n```";
      }
    }

    let bindingNames = agentContext.spawnerConfig.env || hooks.listBindingNames();
    let systemPromptBindings: string;
    if (bindingNames.length == 0) {
      systemPromptBindings =
          "You have not been given access to any bindings; the `env` object is empty.";
    } else {
      systemPromptBindings =
          `You have access to the following Cloudflare Workers bindings via the \`env\` object:\n` +
          `* ${bindingNames.join("\n* ")}`
    }

    systemPrompt = `${SPAWNER_SYSTEM_PROMPT}${systemPromptProps}\n\n${systemPromptBindings}`;
  } else {
    // This is a regular coding agent.

    // Let's include the list of files in the system prompt so that the agent doesn't have to
    // call a tool to list files at the start of every thread.
    // Note: If the log so far indicated that file contents have been observed, then `vesionLock`
    //   will have been set, and this will list the files consistently with that version.
    //   Otherwise, it'll list from the current version, and set `versionLock`, but if the
    //   agent doesn't acutally read any of the files, then the version won't end up being
    //   stored in the log at all, and on the next turn `versionLock` will be unset again. Thus
    //   we don't actually lock in a version until the first time a file is actually read -- but
    //   in the meantime, the system prompt can theoretically change on each request, if the
    //   files are changing. That's fine.
    let currentFiles = [...getSessionYDoc().getMap<Y.Text>().keys()];
    let systemPromptFiles: string;
    if (currentFiles.length == 0) {
      systemPromptFiles = "The project currently has no code files.";
    } else {
      systemPromptFiles =
          `${SYSTEM_PROMPT}\n\nThe project currently contains the following files:` +
          `\n* ${currentFiles.join("\n* ")}`;
    }

    let bindingNames = hooks.listBindingNames();
    let systemPromptBindings: string;
    if (bindingNames.length == 0) {
      systemPromptBindings = "The project currently has no bindings.";
    } else {
      systemPromptBindings =
          `The project is configured with the following Cloudflare Workers bindings:\n` +
          `* ${bindingNames.join("\n* ")}`
    }

    systemPrompt = `${SYSTEM_PROMPT}\n\n${systemPromptFiles}\n\n${systemPromptBindings}`;
  }

  let maxOutputTokens: number | undefined;
  if (typeof chosenModel === "object" && chosenModel.provider &&
      chosenModel.provider.startsWith("workersai")) {
    // Workers AI uses a very low defalut max tokens if we don't set it higher. Qwen 3, Kimi K2.5,
    // and GLM 4.7 all support 131k tokens. These are the only models on Workers AI so far that can
    // even plausibly write code, so let's just assume we're using one of them.
    // TODO: Qwen 3 requires that maxOutputTokens PLUS the input tokens do not exceed 131k or it
    //   throws an exception. We don't know how to count input tokens so for now we use 100k,
    //   leaving 31k headroom. This is obviously a terrible solution and we need to come up with
    //   something better here.
    maxOutputTokens = 100000;
  }

  let tools: ToolSet = {
    readFile: tool({
      description: "Read the content of a file in the project. Note that you will be " +
          "informed any time a file changes, so it is not necessary to read a file again " +
          "after you have already read it once.",
      inputSchema: z.object({
        filename: z.string().describe("Name of the file to read."),
        // TODO: line range?
        // TODO: Claude Code apparently presents the code to the agent with line number
        //   prefixes on each line. Is this worth doing?
      }),
      execute: ({filename}, {toolCallId}) => {
        try {
          let text = getSessionYDoc().getMap<Y.Text>().get(filename);
          if (!text) {
            throw new Error("File does not exist.");
          }
          filesRead.add(filename);
          toolCallNotes.set(toolCallId, {
            observedCodeVersion: versionLock!
          });
          return text.toString();
        } catch (error) {
          toolCallNotes.set(toolCallId, {
            observedCodeVersion: versionLock!,
            error: `${error}`
          });
          throw error;
        }
      }
    }),

    writeFile: tool({
      description: "Write a complete file, creating it if it doesn't exist, or replacing it " +
          "if it does.",
      inputSchema: z.object({
        filename: z.string().describe("Name of the file to write."),
        content: z.string().describe("The entire content of the file to write."),
      }),
      outputSchema: z.object({
        success: z.boolean().describe(
            "Always true to indicate the write succeeded. Failed writes will throw an error."),
        changeId: z.number().describe(
            "Change number assigned to this change, in case we need to refer to it later. " +
            "All writes and edits made at the same time have the same changeId. This ID is not " +
            "directly visible to the user."),
      }),
      execute: ({filename, content}, {toolCallId}) => {
        try {
          let ydoc = getSessionYDoc();

          ydoc.transact(tr => {
            let txt = new Y.Text();
            txt.insert(0, content);
            ydoc.getMap<Y.Text>().set(filename, txt);
          });

          // The agent knows exactly what's in the file, so add it to the `filesRead` set so
          // that it can make further edits without rewriting.
          filesRead.add(filename);

          toolCallNotes.set(toolCallId, {
            observedCodeVersion: versionLock!
          });
          return {success: true, changeId: nextChangeId};
        } catch (error) {
          toolCallNotes.set(toolCallId, {
            observedCodeVersion: versionLock!,
            error: `${error}`
          });
          throw error;
        }
      }
    }),

    editFile: tool({
      description: "Edit content of a file. If you need to edit multiple places in a file " +
          "or across multiple files, you should issue multiple tool calls simultanously, " +
          "rather than in series.",
      inputSchema: z.object({
        filename: z.string().describe("Name of the file to edit."),
        textToReplace: z.string()
            .describe("Exact existing text which is to be replaced. This string must match " +
                "exactly one location in the file, or the edit will fail."),
        replacement: z.string()
            .describe("Text which should be inserted, replacing the matched text."),
        // TODO: Line number hint, to disambiguate multiple matches?
      }),
      outputSchema: z.object({
        success: z.boolean().describe(
            "Always true to indicate the edit succeeded. Failed edits will throw an error."),
        changeId: z.number().describe(
            "Change number assigned to this change, in case we need to refer to it later. " +
            "All writes and edits made at the same time have the same changeId. This ID is not " +
            "directly visible to the user."),
      }),
      execute: ({filename, textToReplace, replacement}, {toolCallId}) => {
        try {
          if (!filesRead.has(filename)) {
            throw new Error("You must read a file before you can edit it.");
          }

          let ydoc = getSessionYDoc();
          let text = ydoc.getMap<Y.Text>().get(filename);
          if (!text) {
            throw new Error("File does not exist.");
          }

          let content = text.toString();
          let pos = content.indexOf(textToReplace);
          if (pos < 0) {
            throw new Error("No matching text was found in the file.");
          }
          if (content.indexOf(textToReplace, pos + 1) >= 0) {
            throw new Error("Multiple matches were found. The text to match must be unique.");
          }

          ydoc.transact(tr => {
            text.delete(pos, textToReplace.length);
            text.insert(pos, replacement);
          });

          return {success: true, changeId: nextChangeId};
        } catch (error) {
          toolCallNotes.set(toolCallId, {
            error: `${error}`
          });
          throw error;
        }
      }
    }),

    observeUserChanges: tool({
      description: "Returns information about changes which the user has made to the " +
          "code.\n" +
          "\n" +
          "This tool is called automatically whenever the user makes changes, by " +
          "inserting a synthetic messages into the chat history as if the assistant " +
          "had called the tool. Hence, you never need to generate a call to this tool, " +
          "but the chat history will automatically contain such calls when you need them.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        revertedFromChangeId: z.optional(z.boolean().describe(
            "Indicates that all changes starting from the giver changeId to the " +
            "current point in the chat history were reverted by the user. The file " +
            "contents have returned to the state they were in immediately before the " +
            "given changeId.")),
        diff: z.optional(z.string().describe(
            "Represents changes made by the user (other than broad reverts), in unified " +
            "diff format.")),
      }),
      execute: ({}, {}) => {
        // The agent shouldn't be calling this explicitly.
        return {};
      },
    }),

    describeBinding: tool({
      description: "Describe one of the Gadget's bindings (members of the Cloudflare " +
          "Workers `env` object), including TypeScript types specifying the API it offers.",
      inputSchema: z.object({
        name: z.string().describe("Name of the binding (a property of `env`)."),
      }),
      execute: async ({name}, {toolCallId}) => {
        try {
          return await hooks.describeBinding(name);
        } catch (error) {
          toolCallNotes.set(toolCallId, {
            error: `${error}`
          });
          throw error;
        }
      }
    }),

    executeCode: tool({
      description: "Executes one-off JavaScript code, returning the output it logs to the " +
          "console. The code will have access to the Gadget's bindings ('env' object), " +
          "so this can be used to directly perform tasks with them. The code runs in a " +
          "sandbox where it cannot talk to the internet, except through the bindings; " +
          "fetch() will not work. Otherwise, the code can call any built-in APIs " +
          "available in Cloudflare Workers.\n" +
          "\n" +
          "When the user asks you to just do a task that can be done with these bindings, " +
          "you should use executeCode to perform the task, instead of adding code to the " +
          "gadget to do it.",
      inputSchema: z.object({
        code: z.string().describe(
            "Code to execute. This must be a complete self-contained JavaScript module " +
            "which exports a single async function, like so:\n" +
            "\n" +
            "```\n" +
            "export default async function(env, ctx) {\n" +
            "  // ... code to execute ...\n" +
            "}\n" +
            "```\n" +
            "\n" +
            "`env` and `ctx` are the usual objects passed to Cloudflare Workers event " +
            "handlers. `env` contains the bindings, and `ctx` contains various functions " +
            "and information related to the execution context."),
      }),
      execute: async ({code}, {toolCallId}) => {
        try {
          let output = await hooks.executeCodeMode(code, agentContext);
          toolCallNotes.set(toolCallId, {
            output: `${output}`
          });
          return output;
        } catch (error) {
          toolCallNotes.set(toolCallId, {
            error: `${error}`
          });
          throw error;
        }
      }
    }),
  };

  if (agentContext.spawnerConfig) {
    // Restrict to a narrower set of tools.
    tools = {
      describeBinding: tools.describeBinding,
      executeCode: tools.executeCode,

      reportOutcome: tool({
        description:
            "Declares that your task is complete and reports whether it succeeded or failed.",
        inputSchema: z.object({
          success: z.boolean().describe(
              "Pass true to indicate that the task was completed successfully, or false to " +
              "indicate that something went wrong and that the user should investigate."),
        }),
        execute: ({success}, {toolCallId}) => {
          // TODO: Actually pay attention to success value and potentially notify user.
          console.log("REPORTED OUTCOME", success);
          return {acknowledged: true};
        }
      })
    };
  }

  await generateText({
    model: chosenModel,
    system: systemPrompt,
    messages: modelMessages,
    abortSignal,
    maxOutputTokens,

    // TODO: I don't quite understand `stopWhen`. It seems like you are required to set it if
    //   you want to support multiple steps at all? What if you don't want to set a limit?
    // Note: I had to increase this to 30 because ChatGPT seems to take LOTS of steps to do
    //   anything.
    // Note: I added reportOutcome as ending the conversation because some dumb models will go
    //   into a loop of repeatly reporting the outcome instead of just ending the conversation
    //   themselves.
    stopWhen: [stepCountIs(30), hasToolCall("reportOutcome")],

    tools,

    onStepFinish: ({ text, reasoningText, toolCalls }) => {
      let msgs: AiChatMessageBody[] = [];

      {
        let msg: AiChatMessageBody = {
          type: "message",
          message: text,
        };
        if (reasoningText) {
          msg.reasoning = reasoningText;
        }
        if (toolCalls.length > 0) {
          msg.toolCalls = toolCalls.map(tool => {
            let result = <AiToolCall>{
              toolCallId: tool.toolCallId,
              toolName: tool.toolName,
              input: tool.input
            };
            if (tool.error) {
              result.error = `${tool.error}`;
            }
            let notes = toolCallNotes.get(tool.toolCallId);
            if (notes) {
              Object.assign(result, notes);
            }
            return result;
          });
        }
        msgs.push(msg);
      }

      if (capturedYdocChanges.length > 0) {
        let update = Y.mergeUpdatesV2(capturedYdocChanges);
        capturedYdocChanges = [];

        msgs.push({
          type: "changes",
          update
        });
      }

      hooks.addChatMessages(chatId, author, msgs);
    },
  });
}
