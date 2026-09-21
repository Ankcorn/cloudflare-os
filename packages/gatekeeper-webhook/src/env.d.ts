declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./webhook.js");
    durableNamespaces: "WebhookConnect" | "WebhookDispatcher" | "WebhookGatekeeper";
  }
  interface Env {}
}

interface ExecutionContext<Props = unknown> { readonly exports: Cloudflare.Exports; }
interface DurableObjectState<Props = unknown> { readonly exports: Cloudflare.Exports; }
