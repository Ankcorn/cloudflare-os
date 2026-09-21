declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./webhook.js");
    durableNamespaces: "WebhookDispatcher" | "WebhookGatekeeper";
  }
}
