export interface InboundMessage {
  id: string;
  /** Who the message is from. Identity comes from here, never from the text. */
  fromPhone: string;
  text: string;
  receivedAt: string;
}

export type MessageHandler = (message: InboundMessage) => Promise<void>;

export interface Channel {
  send(toPhone: string, text: string): Promise<{ id: string }>;
  onMessage(handler: MessageHandler): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}
