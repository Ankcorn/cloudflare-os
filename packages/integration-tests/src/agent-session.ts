import type { RpcCompatible, RpcStub } from "capnweb";
import type {
  AiChatHistoryPage, AiChatMessage, AiChatMetadata, AiChatStreamEvent, AiChatSubscriber,
  AiChatAuthorInfo, AiModelConfig, AuthenticatedApi, GadgetClient, Overseer, PublicApi, WorkpieceId,
  WorkpieceSummary, WorkpiecesSubscriber,
} from "@gadgets/workshop-shared/api";
import type { CodeChange } from "@gadgets/workshop-shared/code-change";
import { RpcTarget, connect, nextUsernames, signUp, stubFor, waitFor } from "./rpc-client.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const IDLE_SETTLE_MS = 2_000;

function connectTyped<Session extends RpcCompatible<Session>>(
    gadget: RpcStub<GadgetClient>, chatId: number): Promise<RpcStub<Session>>;
function connectTyped(gadget: RpcStub<GadgetClient>, chatId: number) {
  return gadget.connectToGadget(chatId);
}

/** Options for creating a local Workshop agent session. */
export type AgentSessionOptions = {
  /** Model to use. It must appear in the account's `listModels()` result. Defaults to the first. */
  modelId?: string;
  /** Optional model to add to the fresh account before its workspace opens. */
  userModel?: { profile: AiChatAuthorInfo; config: AiModelConfig };
  /** Hard limit for each agent turn. Defaults to two minutes. */
  timeoutMs?: number;
};

/** State returned after one local agent turn settles. */
export type AgentTurnResult = {
  history: AiChatMessage[];
  workpieces: WorkpieceSummary[];
  usage: { lastStepTokens?: number; agentChatCostUsd?: number };
};

class TurnCompletion {
  readonly promise: Promise<void>;
  readonly failure: Promise<never>;
  #chatId: number | null;
  #resolve: () => void = () => {};
  #reject: (error: Error) => void = () => {};
  #rejectFailure: (error: Error) => void = () => {};
  #stopAgent: () => Promise<void>;
  #timeout: ReturnType<typeof setTimeout>;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #signal: AbortSignal | undefined;
  #sawActive = false;
  #settled = false;
  #stopRequested = false;
  #pendingMetadata: AiChatMetadata[] = [];
  #pendingMessages: AiChatMessage[] = [];

  constructor(
      chatId: number | null,
      stopAgent: () => Promise<void>,
      timeoutMs: number,
      signal?: AbortSignal) {
    this.#chatId = chatId;
    this.#stopAgent = stopAgent;
    this.#signal = signal;
    this.promise = new Promise<void>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    this.failure = new Promise<never>((_resolve, reject) => { this.#rejectFailure = reject; });
    this.promise.catch(() => {});
    this.failure.catch(() => {});
    this.#timeout = setTimeout(() => {
      this.#stopRequested = true;
      this.#requestStop();
      this.#fail(new Error(`Timed out after ${timeoutMs}ms waiting for the agent turn`));
    }, timeoutMs);
    signal?.addEventListener("abort", this.#onAbort, { once: true });
    if (signal?.aborted) this.#onAbort();
  }

  attach(chatId: number): void {
    if (this.#chatId !== null && this.#chatId !== chatId) {
      throw new Error(`Agent turn is already attached to chat ${this.#chatId}`);
    }
    this.#chatId = chatId;
    const metadata = this.#pendingMetadata;
    const messages = this.#pendingMessages;
    this.#pendingMetadata = [];
    this.#pendingMessages = [];
    for (const entry of metadata) this.metadata(entry);
    for (const entry of messages) this.message(entry);
    if (this.#stopRequested) this.#requestStop();
  }

  metadata(chat: AiChatMetadata): void {
    if (this.#chatId === null) {
      this.#pendingMetadata.push(chat);
      return;
    }
    if (chat.id !== this.#chatId || this.#settled) return;
    if (chat.activeAgent) {
      this.#sawActive = true;
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    } else if (this.#sawActive) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = setTimeout(() => this.#succeed(), IDLE_SETTLE_MS);
    }
  }

  message(entry: AiChatMessage): void {
    if (this.#chatId === null) {
      this.#pendingMessages.push(entry);
      return;
    }
    if (entry.chatId === this.#chatId && entry.type === "error") {
      this.#fail(new Error(entry.message));
    }
  }

  race<T>(operation: PromiseLike<T>): Promise<T> {
    return Promise.race([operation, this.failure]);
  }

  cancel(): void {
    if (this.#settled) return;
    this.#stopRequested = true;
    this.#requestStop();
    this.#fail(new Error("Agent turn was cancelled"));
  }

  dispose(): void {
    clearTimeout(this.#timeout);
    clearTimeout(this.#idleTimer);
    this.#signal?.removeEventListener("abort", this.#onAbort);
  }

  #onAbort = (): void => { this.cancel(); };

  #requestStop(): void {
    if (this.#chatId !== null) this.#stopAgent().catch(() => {});
  }

  #succeed(): void {
    if (this.#settled) return;
    this.#settled = true;
    this.dispose();
    this.#resolve();
  }

  #fail(error: Error): void {
    if (this.#settled) return;
    this.#settled = true;
    this.dispose();
    this.#rejectFailure(error);
    this.#reject(error);
  }
}

class ChatSubscriber extends RpcTarget implements AiChatSubscriber {
  completion: TurnCompletion | undefined;

  streamGeneration(_generation: number): void {}
  metadata(chat: AiChatMetadata): void { this.completion?.metadata(chat); }
  deleted(_chatId: number): void {}
  message(entry: AiChatMessage): void { this.completion?.message(entry); }
  changeApplied(
      _chatId: number, _generation: number, _revision: number, _author: AiChatAuthorInfo,
      _change: CodeChange, _submission?: {clientId: string; seq: number}): void {}
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

/** Drives one fresh local Workshop account and workspace through the production RPC API. */
export class AgentSession implements Disposable {
  readonly #modelId: string;
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
  #turn: TurnCompletion | undefined;
  #timeoutMs: number;
  #disposed = false;
  #failed = false;

  private constructor(
      publicApi: RpcStub<PublicApi>,
      authenticatedApi: RpcStub<AuthenticatedApi>,
      overseer: RpcStub<Overseer>,
      modelId: string,
      timeoutMs: number) {
    this.#publicApi = publicApi;
    this.#authenticatedApi = authenticatedApi;
    this.#overseer = overseer;
    this.#modelId = modelId;
    this.#timeoutMs = timeoutMs;
  }

  /** Create a fresh local account, complete onboarding, and open an isolated workspace. */
  static async create(baseUrl: URL, options: AgentSessionOptions = {}): Promise<AgentSession> {
    const publicApi = connect(baseUrl);
    let authenticatedApi: RpcStub<AuthenticatedApi> | undefined;
    let overseer: RpcStub<Overseer> | undefined;
    let session: AgentSession | undefined;
    try {
      const username = nextUsernames("agent").at(0);
      if (username === undefined) throw new Error("Failed to allocate an integration-test username");
      const authenticated = authenticatedApi = await signUp(publicApi, username);
      if (options.userModel !== undefined) {
        await authenticated.addModel(options.userModel.profile, options.userModel.config);
      }
      const modelId = AgentSession.#selectModel(await authenticated.listModels(), options.modelId);
      if (!await authenticated.isOnboardingCompleted()) {
        await authenticated.setPreferredModel(modelId);
        await authenticated.completeOnboarding();
      }
      const workspace = overseer = await authenticated.newGadget();
      const created = session = new AgentSession(
          publicApi, authenticated, workspace, modelId, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      await created.#initializeSubscriptions();
      await created.#waitForOutputFormats();
      return created;
    } catch (error) {
      if (session === undefined) {
        overseer?.[Symbol.dispose]();
        authenticatedApi?.[Symbol.dispose]();
        publicApi[Symbol.dispose]();
      } else {
        try {
          await session.deleteWorkspace();
        } finally {
          session[Symbol.dispose]();
        }
      }
      throw error;
    }
  }

  /**
   * Send one prompt and wait until the top-level agent has remained idle for two seconds.
   * Persistent callbacks that start after that window are outside this driver's contract.
   */
  async run(prompt: string, signal?: AbortSignal): Promise<AgentTurnResult> {
    this.#assertUsable();
    if (this.#turn !== undefined) throw new Error("An agent turn is already running");

    const completion = new TurnCompletion(
        this.#chatId ?? null, () => this.#stopCurrentAgent(), this.#timeoutMs, signal);
    this.#turn = completion;
    this.#chatSubscriber.completion = completion;
    try {
      let chatId = this.#chatId;
      if (chatId === undefined) {
        const creating = this.#overseer.newChat(prompt, this.#modelId);
        creating.then(id => {
          this.#chatId = id;
          completion.attach(id);
        }, () => {});
        chatId = await completion.race(creating);
        this.#chatId = chatId;
        completion.attach(chatId);
      } else {
        await completion.race(this.#overseer.sendChatMessage(chatId, prompt, this.#modelId));
      }
      await completion.promise;

      const [history, chats] = await Promise.all([
        loadAllChatHistory(before => this.#overseer.getChatHistory(chatId, before)),
        this.#overseer.listChats(),
      ]);
      const metadata = chats.find(chat => chat.id === chatId);
      if (metadata === undefined) throw new Error(`Chat ${chatId} disappeared after its agent turn`);
      const usage: AgentTurnResult["usage"] = {};
      if (metadata.totalTokens !== undefined) usage.lastStepTokens = metadata.totalTokens;
      if (metadata.totalCost !== undefined) usage.agentChatCostUsd = metadata.totalCost;
      return {
        history,
        workpieces: [...this.#workpieceSubscriber.entries.values()],
        usage,
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

  /** Connect a caller-owned verifier stub to this session's provisional Gadget branch. */
  async connectToGadget<Session extends RpcCompatible<Session>>(
      id: WorkpieceId): Promise<RpcStub<Session>> {
    this.#assertUsable();
    if (this.#chatId === undefined) throw new Error("The session has no chat branch yet");
    using gadget = await this.#overseer.getGadget(id);
    return connectTyped<Session>(gadget, this.#chatId);
  }

  /** Delete the local workspace, including after a failed turn. */
  async deleteWorkspace(): Promise<void> {
    if (this.#disposed) throw new Error("AgentSession is disposed");
    if (this.#turn !== undefined) throw new Error("Cannot delete the workspace during an agent turn");
    await this.#overseer.deleteSelf();
    this[Symbol.dispose]();
  }

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

  async #waitForOutputFormats(): Promise<void> {
    await waitFor("the output formats to install (is workshop-backend built?)", async () =>
      (await this.#authenticatedApi.listOutputFormats()).length > 0 ? true : null);
  }

  #stopCurrentAgent(): Promise<void> {
    return this.#chatId === undefined
      ? Promise.resolve()
      : this.#overseer.stopAgent(this.#chatId);
  }

  #assertUsable(): void {
    if (this.#disposed) throw new Error("AgentSession is disposed");
    if (this.#failed) throw new Error("AgentSession cannot be reused after a failed or cancelled turn");
  }

  static #selectModel(models: AiChatAuthorInfo[], requested: string | undefined): string {
    const first = models.at(0);
    if (first === undefined) throw new Error("The Workshop exposes no configured agent models");
    if (requested === undefined) return first.id;
    if (!models.some(model => model.id === requested)) {
      throw new Error(`Model "${requested}" is not available to this account`);
    }
    return requested;
  }
}

export async function loadAllChatHistory(
    loadPage: (beforeSequence?: number) => Promise<AiChatHistoryPage>): Promise<AiChatMessage[]> {
  let page = await loadPage();
  let messages = page.messages;
  const boundaries = new Set<number>();
  while (page.compacted) {
    const boundary = page.compacted.to;
    if (boundaries.has(boundary)) {
      throw new Error(`Chat history repeated compaction boundary ${boundary}`);
    }
    boundaries.add(boundary);
    page = await loadPage(boundary);
    messages = [...page.messages, ...messages];
  }
  return messages;
}
