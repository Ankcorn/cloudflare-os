# Gatekeeper Email

This package provides an email receiving gatekeeper for Gadgets. It allows a Gadget to receive inbound emails at an address like `<name>@<host>` via a hook.

Unlike most gatekeepers which connect to external services, this gatekeeper *is* the service -- it implements a Cloudflare Email Worker that receives mail directly.

## How It Works

The email gatekeeper uses the URL scheme `http://email.localhost:8787/mailbox/<name>` to represent the email address `<name>@<host>`, where `<host>` is the domain configured to route email to this worker.

When a Gadget is connected to an email address:

1. The Gadget's code exports a `WorkerEntrypoint` that implements the `EmailHook` interface.
2. The coding agent calls `setBindingHook` to connect the hook to the binding.
3. The gatekeeper stores the hook reference in a Durable Object keyed by the email username.
4. When an email arrives, the Email Worker routes it to the appropriate DO, which invokes the Gadget's hook with the parsed email content.

Emails are parsed using [postal-mime](https://www.npmjs.com/package/postal-mime), so the hook receives structured data (from, to, subject, text body, HTML body, attachments) rather than raw MIME.

## Creating a Binding

1. Start the dev server (see root README).
2. Create or open a Gadget.
3. In the chat, paste a URL like: `http://email.localhost:8787/mailbox/myinbox`
4. This represents the email address `myinbox@<host>`.
5. The binding will appear as `EMAIL` (the suggested name).

The binding provides an `EmailSession` interface with a single method:

```typescript
interface EmailSession {
  getAddress(): Promise<string>;  // e.g. "myinbox@example.com"
}
```

To actually receive emails, the Gadget must implement a hook. Ask the coding agent to set up a hook for the email binding, or do it manually:

```typescript
// In the Gadget's code:
import { WorkerEntrypoint } from "cloudflare:workers";

export class MyEmailHandler extends WorkerEntrypoint {
  async receiveEmail(email) {
    // email has: from, to, cc, subject, date, text, html, attachments
    console.log(`Got email from ${email.from.address}: ${email.subject}`);
    // Store it, process it, etc.
  }
}
```

Then prompt your coding agent to use the `setBindingHook` tool to connect it:
- Binding: `EMAIL`
- Export name: `MyEmailHandler`

## Local Development

In local development, we pretend the gatekeeper serves `email.localhost`, but we don't actually support receiving real SMTP email.

### Sending a Test Email

In local dev, wrangler exposes a `/cdn-cgi/handler/email` endpoint that simulates inbound email. You can POST raw email content to it using curl.

With the dev server running (`pnpm run dev-server` from the repo root), send a test email:

```bash
curl -X POST 'http://email.localhost:8787/cdn-cgi/handler/email' \
  --url-query 'from=sender@example.com' \
  --url-query 'to=myinbox@example.com' \
  --header 'Content-Type: application/json' \
  --data-raw 'From: "Alice" <sender@example.com>
To: myinbox@example.com
Subject: Hello from local dev
Content-Type: text/plain; charset="utf-8"
Date: Mon, 16 Feb 2026 12:00:00 +0000
Message-ID: <test-123@example.com>

This is a test email body.'
```

The `to` address's local part (`myinbox`) determines which `EmailAddress` Durable Object receives the email. Make sure:
- You have a Gadget with a binding for `http://email.localhost:8787/mailbox/myinbox`
- The binding has a hook connected via `setBindingHook`

If no hook is configured for that address, the email will be rejected.

## Production Configuration

In production, you need to set up [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/) to forward emails to this worker.

### Step 1: Deploy the email gatekeeper to an HTTP host and set env.ORIGIN

All occurrances of `http://email.localhost:8787` in the doc above will in production instead be the hostname on which you are serving the email gatekeeper worker. You need to set the `ORIGIN` environment variable to match this, like:

```
ORIGIN=https://gatekeeper-email.example.workers.dev
```

### Step 2: Enable Email Routing

1. In the Cloudflare dashboard, go to your domain's **Email Routing** settings.
2. Follow the setup wizard to enable Email Routing and configure the required DNS records (MX, SPF, etc.).

### Step 3: Create an Email Worker Route

1. Go to **Email Routing** > **Email Workers**.
2. Create a route that matches the addresses you want to handle. For example:
   - **Custom address**: `*@yourdomain.com` (catch-all) or specific addresses like `gadget-*@yourdomain.com`
   - **Action**: Send to a Worker
   - **Worker**: Select the deployed `gatekeeper-email` worker
3. Alternatively, you can configure this in your wrangler.jsonc for deployment.

### How It Fits Together

```
Internet email → Cloudflare Email Routing → gatekeeper-email worker
                                               │
                                               ├── email() handler parses recipient
                                               │
                                               ▼
                                          EmailAddress DO (per username)
                                               │
                                               ├── loads stored hook Fetcher
                                               │
                                               ▼
                                          Gadget's hook entrypoint
                                          (via Overseer loopback)
```

Each email address maps to a Durable Object named by its local part. The DO stores the hook `Fetcher` in KV storage, which persists across requests. When an email arrives, the DO loads the hook and calls `receiveEmail()` with the parsed email data.
