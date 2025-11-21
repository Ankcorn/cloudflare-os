export type GmailThreadSummary = {
  id: string;
  snippet: string;
  historyId: string;
}

export type GmailMessage = {
  from: string;
  to: string[];
  subject: string;
  timestamp: Date;
  body: string;
}

export type GmailThreadContent = {
  messages: GmailMessage[];
}

export interface GmailSession {
  listThreads(count: number): Promise<GmailThreadSummary[]>;
  readThread(threadId: string): Promise<GmailThreadContent>;
  applyLabel(threadId: string, label: string): Promise<void>;
}
