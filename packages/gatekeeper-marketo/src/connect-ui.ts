// Plain HTML connect form for LaunchPoint credentials.

import type { MarketoConnectDefaults } from "./config";

export function escapeHtml(text: string): string {
  let escapes: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return text.replace(
    /[&<>"']/g,
    c => escapes[c] ?? c,
  );
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/**
 * An HTML response for a page reached only through the connect URL.
 *
 * The URL is itself the capability, so the page is kept out of shared caches and the address is
 * kept out of the `Referer` of anything it links to or loads.
 */
export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
    },
  });
}

/**
 * Reject cross-origin or non-JSON submissions.
 *
 * The connect URL is a capability — anyone holding it can bind credentials to that account — so it
 * must not be usable as a CSRF target from another site.
 */
export function checkMutation(req: Request): Response | undefined {
  if (req.headers.get("origin") !== new URL(req.url).origin) {
    return jsonResponse({ error: "Cross-origin request refused" }, 403);
  }
  if (!(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return jsonResponse({ error: "Expected Content-Type: application/json" }, 415);
  }
  return undefined;
}

/** Standalone page shown when a connect link is unusable, in place of a form that cannot work. */
export function expiredLinkHtml(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Connect Marketo</title>
<style>
  :root { color-scheme: light; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #f6f6f8; margin: 0; padding: 2rem; color: #1a1a1a; }
  main { max-width: 560px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
  section { background: #fff; border-radius: 10px; padding: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  p { margin: 0; font-size: 0.95rem; line-height: 1.5; color: #555; }
</style>
</head>
<body>
<main>
  <h1>Connect Marketo</h1>
  <section><p>${escapeHtml(message)}</p></section>
</main>
</body>
</html>`;
}

/**
 * Render the credential form with non-secret defaults for a new connection or reconnect.
 *
 * The endpoint and Client ID are pre-filled and stay editable. The Client Secret never is: when a
 * safe fallback exists the field becomes optional and the Worker supplies the secret. The secret
 * is never written into HTML.
 */
export function connectPageHtml(params: { defaults: MarketoConnectDefaults }): string {
  let { endpoint, clientId, secretSource } = params.defaults;
  let reconnecting = secretSource === "account";
  let locked = reconnecting ? " readonly" : "";
  let secretHint = secretSource === "account"
    ? "Leave blank to keep the existing Client Secret."
    : secretSource === "deployment"
      ? "Leave blank to connect with this deployment's shared service. Marketo will attribute " +
      "everything you do to that service's API-only user rather than to you, and anyone else on " +
      "this deployment can use it too. To connect as yourself, enter your own Client ID and " +
      "Secret above."
      : "Admin &rarr; Integration &rarr; LaunchPoint &rarr; View Details.";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Connect Marketo</title>
<style>
  :root { color-scheme: light; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #f6f6f8; margin: 0; padding: 2rem; color: #1a1a1a; }
  main { max-width: 560px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
  .sub { color: #666; font-size: 0.9rem; margin-bottom: 1.5rem; }
  section { background: #fff; border-radius: 10px; padding: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  label { display: block; font-size: 0.9rem; font-weight: 600; margin: 1rem 0 0.35rem; }
  label:first-of-type { margin-top: 0; }
  input { width: 100%; box-sizing: border-box; padding: 0.55rem 0.65rem; font-size: 0.95rem; border: 1px solid #ccc; border-radius: 6px; font-family: ui-monospace, monospace; }
  input:focus { outline: 2px solid #5c4c9f; outline-offset: -1px; border-color: #5c4c9f; }
  .hint { font-size: 0.8rem; color: #777; margin-top: 0.3rem; }
  button { margin-top: 1.5rem; width: 100%; padding: 0.65rem 1rem; font-size: 0.95rem; font-weight: 600; border: none; border-radius: 6px; background: #5c4c9f; color: #fff; cursor: pointer; }
  button:hover:not(:disabled) { background: #4a3d80; }
  button:disabled { background: #bbb; cursor: default; }
  .msg { margin-top: 1rem; padding: 0.7rem 0.9rem; border-radius: 6px; font-size: 0.88rem; display: none; }
  .msg.error { display: block; background: #fdecea; color: #8f1d14; }
  .msg.ok { display: block; background: #e7f5ea; color: #1d6b32; }
  details { margin-top: 1.25rem; font-size: 0.85rem; color: #555; }
  summary { cursor: pointer; color: #5c4c9f; }
  ol { margin: 0.6rem 0 0; padding-left: 1.2rem; line-height: 1.6; }
  .setup > li { margin-top: 0.8rem; }
  .setup > li:first-child { margin-top: 0; }
  .setup ol { margin-top: 0.25rem; }
  code { background: #f0f0f3; padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.85em; }
</style>
</head>
<body>
<main>
  <h1>Connect Marketo</h1>
  <div class="sub">Use a LaunchPoint custom service you created in Marketo. Credentials you enter
  here are stored for your account only.</div>

  <section>
    <form id="form">
      <label for="endpoint">Instance endpoint</label>
      <input id="endpoint" name="endpoint" value="${escapeHtml(endpoint)}"${locked}
             placeholder="https://123-ABC-456.mktorest.com" autocomplete="off" spellcheck="false">
      <div class="hint">Admin &rarr; Integration &rarr; Web Services. Under REST API, copy the Endpoint.</div>

      <label for="clientId">Client ID</label>
      <input id="clientId" name="clientId" value="${escapeHtml(clientId)}"${locked}
             placeholder="00000000-0000-0000-0000-000000000000"
             autocomplete="off" spellcheck="false">

      <label for="clientSecret">Client Secret${secretSource ? " <span style=\"font-weight:400;color:#777\">(optional)</span>" : ""}</label>
      <input id="clientSecret" name="clientSecret" type="password" autocomplete="off"
             spellcheck="false">
      <div class="hint">${secretHint}</div>

      <button type="submit" id="submit">Connect</button>
      <div class="msg" id="msg"></div>
    </form>

    <details>
      <summary>How do I create a Marketo Gatekeeper user?</summary>
      <ol class="setup">
        <li><strong>Create an API-only user</strong>
          <ol>
            <li>Go to <strong>Admin &rarr; Security &rarr; Users &amp; Roles</strong>.</li>
            <li>Click <strong>Create API Only User</strong>.</li>
            <li>Enter an email address, such as <code>username+marketo@example.com</code>.</li>
            <li>Assign the roles required for the Gatekeeper's intended access.</li>
            <li>Click <strong>Create API Only User</strong>.</li>
          </ol>
        </li>
        <li><strong>Create a client</strong>
          <ol>
            <li>Go to <strong>Admin &rarr; Integration &rarr; LaunchPoint</strong>.</li>
            <li>Select <strong>New &rarr; New Service</strong>.</li>
            <li>Under <strong>Service</strong>, select <strong>Custom</strong>.</li>
            <li>Under <strong>API Only User</strong>, select the user created in step 1.</li>
            <li>Enter a display name and description.</li>
            <li>Click <strong>Create</strong>.</li>
            <li>Locate the new service and click <strong>View Details</strong>.</li>
            <li>Copy the <strong>Client ID</strong> and <strong>Client Secret</strong>.</li>
          </ol>
        </li>
        <li><strong>Copy the endpoint</strong>
          <ol>
            <li>Go to <strong>Admin &rarr; Integration &rarr; Web Services</strong>.</li>
            <li>Under <strong>REST API</strong>, copy the <strong>Endpoint</strong>.</li>
          </ol>
        </li>
      </ol>
      <p>The roles you assign in step 1 are the real limit on what this connection can do. This
      gatekeeper cannot grant more than those roles allow.</p>
    </details>
  </section>
</main>
<script>
  const form = document.getElementById("form");
  const submit = document.getElementById("submit");
  const msg = document.getElementById("msg");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    msg.className = "msg";
    submit.disabled = true;
    submit.textContent = "Verifying\\u2026";
    try {
      const res = await fetch(location.href, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: document.getElementById("endpoint").value,
          clientId: document.getElementById("clientId").value,
          clientSecret: document.getElementById("clientSecret").value,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || ("Request failed (" + res.status + ")"));
      msg.className = "msg ok";
      msg.textContent = body.scope
        ? "Connected as " + body.scope + ". You can close this window."
        : "Connected. You can close this window.";
      submit.textContent = "Connected";
      setTimeout(() => window.close(), 1200);
    } catch (err) {
      msg.className = "msg error";
      msg.textContent = err.message;
      submit.disabled = false;
      submit.textContent = "Connect";
    }
  });
</script>
</body>
</html>`;
}
