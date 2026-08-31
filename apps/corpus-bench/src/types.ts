export type MessageFolder = "INBOX" | "Sent" | "Archive" | "Trash";

export interface SyntheticAttachment {
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * One synthetic message. Deliberately schema-light — this is a stand-in for
 * the real product's Message/Thread tables, which don't exist yet (see the
 * ticket's resolution comment). It carries exactly what the loaders and the
 * search benchmarks need, nothing a future Message schema decision should be
 * inferred from.
 */
export interface SyntheticMessage {
  id: string;
  mailAccountId: number;
  threadId: string;
  threadDepth: number;
  positionInThread: number;
  folder: MessageFolder;
  fromAddress: string;
  toAddresses: string[];
  subject: string;
  sentAt: Date;
  bodyText: string;
  bodyHtml: string | null;
  attachments: SyntheticAttachment[];
  sizeBytes: number;
}

export interface CorpusConfig {
  seed: number;
  messageCount: number;
  threadCount: number;
  mailAccounts: number;
}
