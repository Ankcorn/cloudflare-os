import { useState, useEffect, useRef, useCallback } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Blueprint, Hexagon } from "@phosphor-icons/react";
import { useKumoToastManager } from "@cloudflare/kumo";
import { ChatInput } from "../ChatInterface";
import GadgetList from "../components/GadgetList";
import HomeBlueprintList from "../components/HomeBlueprintList";
import MeshBackground from "../components/MeshBackground";
import { useAuthenticatedApi } from "../AuthContext";
import { RpcStub } from "capnweb";
import {
  Overseer,
  AiChatAuthorInfo,
  CapsuleSpecifier,
} from "@gadgets/workshop-shared/api";
import {
  getStoredSelectedModel,
  persistSelectedModel,
} from "../modelSelection";
import { formatDocumentTitle, useDocumentTitle } from "../useDocumentTitle";

export const Route = createFileRoute("/")({ component: HomePage });

function HomePage() {
  useDocumentTitle(formatDocumentTitle("Home"));

  const { authenticatedApi } = useAuthenticatedApi();
  const navigate = useNavigate();
  const toasts = useKumoToastManager();

  const [workTab, setWorkTab] = useState<'gadgets' | 'blueprints'>('gadgets');

  const [models, setModels] = useState<AiChatAuthorInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    authenticatedApi
      .listModels()
      .then((list) => {
        if (cancelled) return;
        setModels(list);
        setSelectedModel(getStoredSelectedModel(list));
      })
      .catch((err) => {
        console.error("Failed to fetch models:", err);
        toasts.add({ title: "Couldn't load AI models", variant: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [authenticatedApi]);

  const handleModelChange = useCallback((value: string | null) => {
    setSelectedModel(value);
    persistSelectedModel(value);
  }, []);

  // Pre-create a provisional gadget as soon as the user starts interacting,
  // so that navigation after submit is instant.
  const provisionalOverseerRef = useRef<{ stub: RpcStub<Overseer> } | null>(
    null,
  );

  const ensureProvisionalGadget = useCallback(() => {
    if (!provisionalOverseerRef.current) {
      // Use promise pipelining — no await needed
      const overseer = authenticatedApi.newGadget();
      provisionalOverseerRef.current = { stub: overseer };
    }
  }, [authenticatedApi]);

  // Dispose the provisional overseer on unmount if it was never consumed by submit
  useEffect(() => {
    return () => {
      provisionalOverseerRef.current?.stub[Symbol.dispose]();
      provisionalOverseerRef.current = null;
    };
  }, []);

  const handleSend = useCallback(
    async (
      message: string,
      modelId: string | null,
      capsules?: CapsuleSpecifier[],
    ) => {
      try {
        ensureProvisionalGadget();
        const overseer = provisionalOverseerRef.current!.stub;
        const metadata = await overseer.getMetadata();
        await overseer.newChat(message, modelId, capsules);
        // Dispose the provisional stub — the gadget editor will open its own.
        provisionalOverseerRef.current?.stub[Symbol.dispose]();
        provisionalOverseerRef.current = null;
        navigate({ to: "/gadget/$id", params: { id: metadata.id } });
      } catch (err) {
        console.error("Failed to create gadget:", err);
        provisionalOverseerRef.current?.stub[Symbol.dispose]();
        provisionalOverseerRef.current = null;
        toasts.add({ title: "Failed to create gadget", variant: "error" });
      }
    },
    [ensureProvisionalGadget, navigate],
  );

  const getOverseer = useCallback((): RpcStub<Overseer> => {
    ensureProvisionalGadget();
    return provisionalOverseerRef.current!.stub;
  }, [ensureProvisionalGadget]);

  const createCapsuleGatekeeper = useCallback(
    (accountId: number, url: string) => {
      ensureProvisionalGadget();
      return provisionalOverseerRef.current!.stub.newGatekeeper(
        accountId,
        url,
      );
    },
    [ensureProvisionalGadget],
  );

  return (
    <div className="home-layout min-h-[calc(100vh-3.5rem)] flex flex-col lg:flex-row">
      <div className="lg:w-1/2 flex flex-col items-center justify-center px-6 sm:px-10 lg:px-14 py-12 lg:py-0 relative overflow-hidden bg-kumo-base">
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage:
              "radial-gradient(circle, var(--color-kumo-line) 1px, transparent 1px)",
            backgroundSize: "24px 24px",
            maskImage:
              "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 70%)",
            WebkitMaskImage:
              "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 70%)",
          }}
        />
        <MeshBackground />
        <div className="max-w-lg xl:max-w-xl w-full relative">
          <div className="relative mb-8">
            <Hexagon
              aria-hidden="true"
              className="pointer-events-none absolute -right-2 -top-8 rotate-12 text-kumo-brand opacity-[0.08] sm:right-2 sm:top-[-2.75rem]"
              size={112}
              weight="bold"
            />
            <h1 className="relative text-4xl sm:text-5xl font-semibold tracking-tight leading-tight text-kumo-default">
              What are we working on?
            </h1>
            <p className="mt-3 text-base text-kumo-subtle max-w-md">
              Ask a question, build an app, or create an agent that works with
              your tools and data.
            </p>
          </div>

          <div className="relative isolate -mx-4 w-[calc(100%+2rem)] max-w-2xl group/prompt">
            <div className="prompt-glow group-focus-within/prompt:opacity-0 transition-opacity" />
            <ChatInput
              createCapsuleGatekeeper={createCapsuleGatekeeper}
              getOverseer={getOverseer}
              onSend={handleSend}
              isAgentActive={false}
              models={models}
              selectedModel={selectedModel}
              onModelChange={handleModelChange}
              newChat
              autoFocus
              minRows={3}
            />
          </div>
        </div>
      </div>

      <div className="lg:w-1/2 border-t lg:border-t-0 lg:border-l border-kumo-line bg-kumo-elevated min-h-0 lg:max-h-[calc(100vh-3.5rem)] flex flex-col">
        <div className="px-6 sm:px-10 lg:px-10 pt-10 mb-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-kumo-default">
                Your gadgets
              </h2>
              <p className="mt-1 text-[14px] leading-5 font-normal tracking-[-0.25px] text-kumo-subtle">
                Open a gadget or start from a saved blueprint.
              </p>
            </div>
            <div className="flex shrink-0 items-center rounded-full border border-kumo-line bg-kumo-base p-0.5 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
              <button
                type="button"
                onClick={() => setWorkTab('gadgets')}
                className={`group inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-3 text-[13px] font-medium tracking-[-0.25px] transition-[background-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.98] ${
                  workTab === 'gadgets'
                    ? 'bg-[rgba(255,72,1,0.10)] text-kumo-default shadow-[0_1px_2px_rgba(82,16,0,0.05)]'
                    : 'text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default'
                }`}
              >
                <Hexagon
                  size={13}
                  weight="bold"
                  className={workTab === 'gadgets' ? 'text-kumo-brand' : 'text-kumo-inactive transition-colors group-hover:text-kumo-subtle'}
                />
                Gadgets
              </button>
              <button
                type="button"
                onClick={() => setWorkTab('blueprints')}
                className={`group inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-3 text-[13px] font-medium tracking-[-0.25px] transition-[background-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.98] ${
                  workTab === 'blueprints'
                    ? 'bg-[rgba(255,72,1,0.10)] text-kumo-default shadow-[0_1px_2px_rgba(82,16,0,0.05)]'
                    : 'text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default'
                }`}
              >
                <Blueprint
                  size={13}
                  weight="regular"
                  className={workTab === 'blueprints' ? 'text-kumo-brand' : 'text-kumo-inactive transition-colors group-hover:text-kumo-subtle'}
                />
                Blueprints
              </button>
            </div>
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <div className={workTab === 'gadgets' ? 'h-full' : 'hidden h-full'}>
            <GadgetList showHeader={false} />
          </div>
          <div className={workTab === 'blueprints' ? 'h-full' : 'hidden h-full'}>
            <HomeBlueprintList />
          </div>
        </div>
      </div>
    </div>
  );
}
