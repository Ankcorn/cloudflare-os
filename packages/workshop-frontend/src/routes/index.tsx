import { useState, useEffect, useRef, useCallback } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useKumoToastManager } from "@cloudflare/kumo";
import { ChatInput } from "../ChatInterface";
import GadgetList from "../components/GadgetList";
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

export const Route = createFileRoute("/")({ component: HomePage });

function HomePage() {
  const { authenticatedApi } = useAuthenticatedApi();
  const navigate = useNavigate();
  const toasts = useKumoToastManager();

  // ── model selector ──────────────────────────────────────────────────────────
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

  // ── provisional gadget ──────────────────────────────────────────────────────
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

  // ── submit ──────────────────────────────────────────────────────────────────
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
      {/* Left: Hero + Prompt */}
      <div className="lg:w-1/2 flex flex-col items-center justify-center px-6 sm:px-10 lg:px-14 py-12 lg:py-0 relative overflow-hidden bg-kumo-base">
        {/* Dot grid — fades from top to bottom */}
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
          <div className="mb-8">
            <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight leading-tight text-kumo-default">
              What do you want to create?
            </h1>
            <p className="mt-3 text-base text-kumo-subtle max-w-md">
              Describe your gadget, connect your data sources, and we&apos;ll
              build it on Cloudflare Workers.
            </p>
          </div>

          {/* Glow + ChatInput */}
          <div className="relative isolate w-full max-w-2xl mx-auto group/prompt">
            {/* Breathing glow — hidden when focused via group-focus-within */}
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
              attachLabel="Connect"
            />
          </div>
        </div>
      </div>

      {/* Right: Gadgets list */}
      <div className="lg:w-1/2 border-t lg:border-t-0 lg:border-l border-kumo-line bg-kumo-elevated min-h-0 lg:max-h-[calc(100vh-3.5rem)] flex flex-col">
        <GadgetList />
      </div>
    </div>
  );
}
