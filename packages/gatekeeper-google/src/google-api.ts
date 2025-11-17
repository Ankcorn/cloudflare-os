// Basic helpers talking to Google API
//
// This file was lagely vibe-coded based on an interface spec.

import { GmailMessage, GmailThreadContent, GmailThreadSummary } from "./types";

export type GoogleAccessToken = {
  token: string;
  expires: Date;
};

// Exchange a refresh token for an access token.
export async function getAccessToken(refreshToken: string, clientId: string, clientSecret: string)
    : Promise<GoogleAccessToken> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to refresh access token: ${response.status} ${errorText}`);
  }

  const data = await response.json() as {
    access_token: string;
    expires_in: number;
  };

  return {
    token: data.access_token,
    expires: new Date(Date.now() + data.expires_in * 1000),
  };
}

// =======================================================================================

export class GmailApi {
  // The getAccessToken() callback obtains a current access token. It should be called before
  // each operation.
  constructor(private getAccessToken: () => Promise<string>) {}

  // List the top `count` threads in the user's inbox.
  async listThreads(count: number): Promise<GmailThreadSummary[]> {
    const accessToken = await this.getAccessToken();

    const response = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads?maxResults=${count}`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to list threads: ${response.status} ${errorText}`);
    }

    const data = await response.json() as {
      threads?: Array<{
        id: string;
        snippet: string;
        historyId: string;
      }>;
    };

    if (!data.threads) {
      return [];
    }

    return data.threads;
  }

  // Obtain the email content of the given thread ID.
  async readThread(threadId: string): Promise<GmailThreadContent> {
    const accessToken = await this.getAccessToken();

    const response = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to read thread: ${response.status} ${errorText}`);
    }

    const threadData = await response.json() as {
      messages: Array<{
        payload: {
          headers: Array<{ name: string; value: string }>;
          parts?: Array<{
            mimeType: string;
            body: { data?: string };
          }>;
          body?: { data?: string };
        };
        internalDate: string;
      }>;
    };

    const messages: GmailMessage[] = threadData.messages.map(message => {
      const getHeader = (name: string) =>
        message.payload.headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

      // Extract body text
      let body = '';

      // Try to get body from main payload
      if (message.payload.body?.data) {
        body = atob(message.payload.body.data.replace(/-/g, '+').replace(/_/g, '/'));
      }
      // Try to get body from parts (for multipart messages)
      else if (message.payload.parts) {
        for (const part of message.payload.parts) {
          if (part.mimeType === 'text/plain' && part.body.data) {
            body = atob(part.body.data.replace(/-/g, '+').replace(/_/g, '/'));
            break;
          }
        }

        // Fallback to HTML if no plain text found
        if (!body) {
          for (const part of message.payload.parts) {
            if (part.mimeType === 'text/html' && part.body.data) {
              body = atob(part.body.data.replace(/-/g, '+').replace(/_/g, '/'));
              break;
            }
          }
        }
      }

      const from = getHeader('From');
      const to = getHeader('To');
      const subject = getHeader('Subject');

      // Extract email addresses from "Name <email>" format
      const extractEmail = (address: string) => {
        const match = address.match(/<([^>]+)>/);
        return match ? match[1] : address.trim();
      };

      const toAddresses = to.split(',').map(addr => extractEmail(addr.trim())).filter(Boolean);

      return {
        from: extractEmail(from),
        to: toAddresses,
        subject,
        timestamp: new Date(parseInt(message.internalDate)),
        body: body.trim(),
      };
    });

    return { messages };
  }

  // Apply a label to the given thread ID.
  async applyLabel(threadId: string, label: string): Promise<void> {
    const accessToken = await this.getAccessToken();

    // First, get or create the label ID
    let labelId: string;

    // Try to find existing label
    const labelsResponse = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/labels',
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      }
    );

    if (!labelsResponse.ok) {
      const errorText = await labelsResponse.text();
      throw new Error(`Failed to list labels: ${labelsResponse.status} ${errorText}`);
    }

    const labelsData = await labelsResponse.json() as {
      labels: Array<{ id: string; name: string }>;
    };

    const existingLabel = labelsData.labels.find(l => l.name === label);

    if (existingLabel) {
      labelId = existingLabel.id;
    } else {
      // Create new label
      const createResponse = await fetch(
        'https://gmail.googleapis.com/gmail/v1/users/me/labels',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: label,
            labelListVisibility: 'labelShow',
            messageListVisibility: 'show',
          }),
        }
      );

      if (!createResponse.ok) {
        const errorText = await createResponse.text();
        throw new Error(`Failed to create label: ${createResponse.status} ${errorText}`);
      }

      const newLabel = await createResponse.json() as { id: string };
      labelId = newLabel.id;
    }

    // Apply the label to the thread
    const modifyResponse = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}/modify`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          addLabelIds: [labelId],
        }),
      }
    );

    if (!modifyResponse.ok) {
      const errorText = await modifyResponse.text();
      throw new Error(`Failed to apply label: ${modifyResponse.status} ${errorText}`);
    }
  }
}
