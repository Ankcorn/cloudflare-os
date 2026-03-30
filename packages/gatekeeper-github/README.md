# Gatekeeper GitHub

This package provides GitHub OAuth integration for Gadgets, enabling gadgets to access GitHub repositories, issues, and pull requests on behalf of users.

## Setting Up GitHub OAuth Credentials

If you're running this project locally and want to use GitHub integrations, you'll need to create your own GitHub OAuth app. This guide walks you through the process.

### Step 1: Create a GitHub OAuth App

1. Go to [GitHub Settings > Developer settings > OAuth Apps](https://github.com/settings/developers)
2. Click **New OAuth App**
3. Fill in the application details:
   - **Application name**: Enter anything (e.g., "Gadgets Local Dev")
   - **Homepage URL**: `http://localhost:3000`
   - **Authorization callback URL**: `http://localhost:8787/gatekeeper/github/oauth`
4. Click **Register application**

### Step 2: Generate a Client Secret

On the app's settings page after registration:

1. Click **Generate a new client secret**
2. Copy the **Client ID** and the generated **Client secret** — you'll need both in the next step.

### Step 3: Configure Your Local Environment

Create a `.env` file in this package's directory (`packages/gatekeeper-github/.env`):

```bash
CLIENT_ID=your-client-id-here
CLIENT_SECRET=your-client-secret-here
```

> **Note**: The `.env` file is gitignored and should never be committed.

### Step 4: Verify Setup

1. Start the application in dev mode (see instructions in the root README.md).
2. Create or open a gadget.
3. Navigate to the **Connections** tab.
4. Click **+ New Connection**.
5. For the URL, enter a GitHub repository URL (e.g., `https://github.com/owner/repo`).
6. Click **Next**.
7. You will be prompted to connect an account. Click **GitHub**.
8. You should be redirected to GitHub's authorization page in a new tab.
9. After granting access, the tab closes, and you're back to Gadgets.
10. The GitHub account you just connected should appear under **Your Accounts**. Click it.
11. You now have access to that repository's issues, pull requests, and more.

You can also see your connected accounts and add and remove them in the settings (accessed through the account menu in the upper-right).

## Troubleshooting

### "redirect_uri_mismatch" error

The callback URL in your OAuth app settings doesn't match what the app is sending. Double-check that you set it to exactly `http://localhost:8787/gatekeeper/github/oauth` (no trailing slash, `http` not `https`).

### "bad_verification_code" error

The authorization code has expired or already been used. Return to Gadgets and try connecting again.

### "Not configured" page during authorization

Your `CLIENT_ID` or `CLIENT_SECRET` is missing. Make sure the `.env` file exists at `packages/gatekeeper-github/.env` and contains both values, then restart the dev server.
