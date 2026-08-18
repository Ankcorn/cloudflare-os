import type { RpcCompatible, RpcStub } from "capnweb";
import type {
  AiChatMessage, AiChatMetadata, AiChatStreamEvent, AiChatSubscriber, AiChatAuthorInfo,
  AuthenticatedApi, CodeSubscriber, CodeUpdate, GadgetClient, Overseer, PublicApi,
  WorkpieceId, WorkpieceSummary, WorkpiecesSubscriber,
} from "@gadgets/workshop-shared/api";
import * as Y from "yjs";
import {
  AgentTurnCompletion, buildSourceSnapshot, loadAllChatHistory,
} from "./agent-session-internals.js";
import type { SourceSnapshot } from "./agent-session-internals.js";
import { RpcTarget, connect, nextUsernames, signUp, stubFor } from "./rpc-client.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_SETTLE_DEBOUNCE_MS = 500;

function connectTyped<Session extends RpcCompatible<Session>>(
    gadget: RpcStub<GadgetClient>, chatId?: number): Promise<RpcStub<Session>>;
function connectTyped(gadget: RpcStub<GadgetClient>, chatId?: number) {
  return gadget.connectToGadget(chatId);
}

/** Options for creating an isolated production Workshop agent session. */
export type AgentSessionOptions = {
  /** Model to use. It must appear in the new workspace's `listModels()` result. Defaults to the first. */
  modelId?: string;
  /** Alphanumeric prefix for the fresh account name. */
  usernamePrefix?: string;
  /** Hard limit for each agent turn. Defaults to two minutes. */
  timeoutMs?: number;
};

/** Options for one prompt in an agent session. */
export type AgentTurnOptions = {
  /** Merge all proposed changes, including the current live draft, after the agent settles. */
  acceptChanges?: boolean;
  /** Cancels the turn by calling `stopAgent()` and rejecting the run. */
  signal?: AbortSignal;
};

/** The branch a verifier should connect to. */
export type AgentGadgetBranch = "accepted" | "chat";

/** Sources accepted from a turn, keyed by each `WorkpieceSummary.filesRoot`. */
export type AgentSourceSnapshot = SourceSnapshot;

/** Authoritative state returned after one agent turn settles. */
export type AgentTurnResult = {
  /** Chat created by the first turn and reused by later turns. */
  chatId: number;
  /** Complete canonical chat history in ascending sequence order. */
  history: AiChatMessage[];
  /** Workpieces known when the turn finished. */
  workpieces: WorkpieceSummary[];
  /** Agent error messages posted during the turn. Empty when the turn completed normally. */
  agentErrors: string[];
  /** Present only when `acceptChanges` was requested. */
  source?: AgentSourceSnapshot;
};

/** Return the final user-visible assistant text from canonical chat history. */
export function finalAssistantText(history: readonly AiChatMessage[]): string {
  for (let index = history.length - 1; index >= 0; index--) {
    const entry = history[index];
    if (entry?.type === "message" && entry.author.type === "agent" && entry.message !== "") {
      return entry.message;
    }
  }
  return "";
}

class ChatSubscriber extends RpcTarget implements AiChatSubscriber {
  completion: AgentTurnCompletion | undefined;

  streamGeneration(_generation: number): void {}
  metadata(chat: AiChatMetadata): void { this.completion?.metadata(chat); }
  deleted(_chatId: number): void {}
  message(_entry: AiChatMessage): void {}
  draftUpdate(
      _chatId: number, _timestamp: Date, _author: AiChatAuthorInfo, _update: Uint8Array): void {}
  draftCleared(_chatId: number): void {}
  stream(_chatId: number, _event: AiChatStreamEvent): void {}
}

class WorkpieceSubscriber extends RpcTarget implements WorkpiecesSubscriber {
  readonly entries = new Map<WorkpieceId, WorkpieceSummary>();
  readonly readyPromise: Promise<void>;
  #resolveReady: () => void = () => {};

  constructor() {
    super();
    this.readyPromise = new Promise<void>(resolve => { this.#resolveReady = resolve; });
  }

  entry(summary: WorkpieceSummary): void { this.entries.set(summary.id, summary); }
  removed(id: WorkpieceId): void { this.entries.delete(id); }
  ready(): void { this.#resolveReady(); }
}

class SourceSubscriber extends RpcTarget implements CodeSubscriber {
  readonly readyPromise: Promise<void>;
  version = 0;
  #doc: Y.Doc;
  #resolveReady: () => void = () => {};

  constructor(doc: Y.Doc) {
    super();
    this.#doc = doc;
    this.readyPromise = new Promise<void>(resolve => { this.#resolveReady = resolve; });
  }

  update(update: CodeUpdate): void {
    Y.applyUpdateV2(this.#doc, update.update);
    this.version = update.version;
  }

  ready(): void { this.#resolveReady(); }
}

/**
 * Drives the production Workshop RPC lifecycle for one fresh user and workspace.
 *
 * The class deliberately does not interpret agent output. Callers own verification and evaluation.
 * Dispose the session when finished; verifier stubs returned by this class remain caller-owned.
 */
export class AgentSession implements Disposable {
  /** Model selected from the workspace's `listModels()` result. */
  readonly modelId: string;
  /** ID of the fresh workspace owned by this session's fresh user. */
  readonly workspaceId: string;
  #publicApi: RpcStub<PublicApi>;
  #authenticatedApi: RpcStub<AuthenticatedApi>;
  #overseer: RpcStub<Overseer>;
  #chatSubscriber = new ChatSubscriber();
  #chatSubscriberStub: RpcStub<ChatSubscriber> | undefined;
  #chatSubscription: RpcStub<{}> | undefined;
  #workpieceSubscriber = new WorkpieceSubscriber();
  #workpieceSubscriberStub: RpcStub<WorkpieceSubscriber> | undefined;
  #workpieceSubscription: RpcStub<{}> | undefined;
  #chatId: number | undefined;
  #turn: AgentTurnCompletion | undefined;
  #timeoutMs: number;
  #settleDebounceMs: number;
  #disposed = false;
  #failed = false;

  private constructor(
      publicApi: RpcStub<PublicApi>,
      authenticatedApi: RpcStub<AuthenticatedApi>,
      overseer: RpcStub<Overseer>,
      workspaceId: string,
      modelId: string,
      timeoutMs: number) {
    this.#publicApi = publicApi;
    this.#authenticatedApi = authenticatedApi;
    this.#overseer = overseer;
    this.workspaceId = workspaceId;
    this.modelId = modelId;
    this.#timeoutMs = timeoutMs;
    this.#settleDebounceMs = DEFAULT_SETTLE_DEBOUNCE_MS;
  }

  /** Create a fresh account and workspace, then establish subscriptions before any chat starts. */
  static async create(baseUrl: URL, options: AgentSessionOptions = {}): Promise<AgentSession> {
    const publicApi = connect(baseUrl);
    let authenticatedApi: RpcStub<AuthenticatedApi> | undefined;
    let overseer: RpcStub<Overseer> | undefined;
    let session: AgentSession | undefined;
    try {
      const username = nextUsernames(options.usernamePrefix ?? "agent").at(0);
      if (username === undefined) throw new Error("Failed to allocate an integration-test username");
      authenticatedApi = await signUp(publicApi, username);
      overseer = await authenticatedApi.newGadget();
      const [metadata, models] = await Promise.all([
        overseer.getMetadata(),
        overseer.listModels(),
      ]);
      const modelId = AgentSession.#selectModel(models, options.modelId);
      session = new AgentSession(
          publicApi, authenticatedApi, overseer, metadata.id, modelId,
          options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      await session.#initializeSubscriptions();
      return session;
    } catch (error) {
      if (session === undefined) {
        overseer?.[Symbol.dispose]();
        authenticatedApi?.[Symbol.dispose]();
        publicApi[Symbol.dispose]();
      } else {
        session[Symbol.dispose]();
      }
      throw error;
    }
  }

  /**
   * Send a prompt. The first call creates a chat; later calls continue that same chat.
   * History is fetched through every compaction page after the turn settles.
   */
  async run(prompt: string, options: AgentTurnOptions = {}): Promise<AgentTurnResult> {
    this.#assertUsable();
    if (this.#turn !== undefined) throw new Error("An agent turn is already running");

    const existingChatId = this.#chatId ?? null;
    const completion = new AgentTurnCompletion(
        existingChatId,
        () => this.#stopCurrentAgent(),
        this.#timeoutMs,
        this.#settleDebounceMs,
        options.signal);
    this.#turn = completion;
    this.#chatSubscriber.completion = completion;
    try {
      if (this.#chatId === undefined) {
        this.#chatId = await this.#overseer.newChat(prompt, this.modelId);
        completion.attach(this.#chatId);
      } else {
        await this.#overseer.sendChatMessage(this.#chatId, prompt, this.modelId);
      }
      await completion.promise;

      let history = await this.#loadHistory(this.#chatId);
      let source: AgentSourceSnapshot | undefined;
      if (options.acceptChanges) {
        source = await this.#acceptChanges(this.#chatId, history);
        history = await this.#loadHistory(this.#chatId);
      }
      return {
        chatId: this.#chatId,
        history,
        workpieces: this.workpieces(),
        agentErrors: history.flatMap(entry => entry.type === "error" ? [entry.message] : []),
        ...(source === undefined ? {} : { source }),
      };
    } catch (error) {
      this.#failed = true;
      throw error;
    } finally {
      completion.dispose();
      if (this.#chatSubscriber.completion === completion) {
        this.#chatSubscriber.completion = undefined;
      }
      if (this.#turn === completion) this.#turn = undefined;
    }
  }

  /** Stop and reject the active turn. Does nothing while idle. */
  cancel(): void {
    this.#turn?.cancel();
  }

  /** Current workpieces discovered through `subscribeToWorkpieces()`. */
  workpieces(): WorkpieceSummary[] {
    return [...this.#workpieceSubscriber.entries.values()];
  }

  /** Obtain a caller-owned verifier capability for one gadget workpiece. */
  getGadget(id: WorkpieceId): Promise<RpcStub<GadgetClient>> {
    this.#assertUsable();
    return this.#overseer.getGadget(id);
  }

  /**
   * Connect a caller-owned, typed verifier stub to accepted code or this session's chat branch.
   */
  async connectToGadget<Session extends RpcCompatible<Session>>(
      id: WorkpieceId, branch: AgentGadgetBranch = "chat"): Promise<RpcStub<Session>> {
    this.#assertUsable();
    using gadget = await this.#overseer.getGadget(id);
    if (branch === "chat" && this.#chatId === undefined) {
      throw new Error("The session has no chat branch yet");
    }
    return connectTyped<Session>(gadget, branch === "chat" ? this.#chatId : undefined);
  }

  /** Connect a caller-owned typed verifier stub to this session's provisional chat branch. */
  async connectToProvisionalGadget<Session extends RpcCompatible<Session>>(
      id: WorkpieceId): Promise<RpcStub<Session>> {
    return this.connectToGadget<Session>(id, "chat");
  }

  /** Merge the current provisional chat branch and return its accepted source snapshot. */
  async acceptChanges(): Promise<AgentSourceSnapshot> {
    this.#assertUsable();
    if (this.#turn !== undefined) throw new Error("Cannot accept changes while an agent turn is running");
    if (this.#chatId === undefined) throw new Error("The session has no chat branch to accept");
    const history = await this.#loadHistory(this.#chatId);
    return this.#acceptChanges(this.#chatId, history);
  }

  async #acceptChanges(chatId: number, history: readonly AiChatMessage[]): Promise<AgentSourceSnapshot> {
    const mergeThrough = history.at(-1)?.sequence ?? null;
    await this.#overseer.mergeChanges(chatId, mergeThrough, { includeDraft: true });
    return this.#readAcceptedSource();
  }

  /** Dispose subscriptions, callback targets, RPC capabilities, and the WebSocket session. */
  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#turn?.cancel();
    this.#turn?.dispose();
    this.#chatSubscription?.[Symbol.dispose]();
    this.#workpieceSubscription?.[Symbol.dispose]();
    this.#chatSubscriberStub?.[Symbol.dispose]();
    this.#workpieceSubscriberStub?.[Symbol.dispose]();
    this.#overseer[Symbol.dispose]();
    this.#authenticatedApi[Symbol.dispose]();
    this.#publicApi[Symbol.dispose]();
  }

  async #initializeSubscriptions(): Promise<void> {
    this.#chatSubscriberStub = stubFor(this.#chatSubscriber);
    this.#chatSubscription = await this.#overseer.subscribeToChat(this.#chatSubscriberStub);
    this.#workpieceSubscriberStub = stubFor(this.#workpieceSubscriber);
    this.#workpieceSubscription = await this.#overseer.subscribeToWorkpieces(
        this.#workpieceSubscriberStub);
    await this.#workpieceSubscriber.readyPromise;
  }

  async #loadHistory(chatId: number): Promise<AiChatMessage[]> {
    return loadAllChatHistory(before => this.#overseer.getChatHistory(chatId, before));
  }

  async #readAcceptedSource(): Promise<AgentSourceSnapshot> {
    const doc = new Y.Doc();
    const subscriber = new SourceSubscriber(doc);
    using subscriberStub = stubFor(subscriber);
    let subscription: RpcStub<{}> | undefined;
    try {
      subscription = await this.#overseer.subscribeToCode(subscriberStub);
      await subscriber.readyPromise;
      return buildSourceSnapshot(doc, subscriber.version, this.workpieces());
    } finally {
      subscription?.[Symbol.dispose]();
      doc.destroy();
    }
  }

  #stopCurrentAgent(): Promise<void> {
    if (this.#chatId === undefined) return Promise.resolve();
    return this.#overseer.stopAgent(this.#chatId);
  }

  #assertUsable(): void {
    if (this.#disposed) throw new Error("AgentSession is disposed");
    if (this.#failed) throw new Error("AgentSession cannot be reused after a failed or cancelled turn");
  }

  static #selectModel(models: AiChatAuthorInfo[], requested: string | undefined): string {
    if (models.length === 0) throw new Error("The Workshop exposes no configured agent models");
    if (requested === undefined) {
      const first = models.at(0);
      if (first === undefined) throw new Error("The Workshop exposes no configured agent models");
      return first.id;
    }
    if (!models.some(model => model.id === requested)) {
      throw new Error(`Model "${requested}" is not exposed by this workspace`);
    }
    return requested;
  }
}
