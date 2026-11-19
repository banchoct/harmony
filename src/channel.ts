export interface VoiceNote {
  bytes: Uint8Array;
  mimeType: string;
  /** Seconds reported by WhatsApp, when the payload has them. */
  seconds?: number | null;
}

export interface InboundMessage {
  id: string;
  /** Who the message is from. Identity comes from here, never from the text. */
  fromPhone: string;
  /** Empty when the message is a voice note or a file with no caption. */
  text: string;
  receivedAt: string;
  /** A voice note to transcribe. Held in memory only. */
  audio?: VoiceNote;
  /** The voice note could not be downloaded. */
  audioFailed?: boolean;
  /** The voice note is over the transcriber's size limit. Bytes are not kept. */
  audioTooLarge?: boolean;
  audioSeconds?: number | null;
  audioBytes?: number | null;
  /** A file came with the message. Harmony does not read files yet. */
  attachment?: { kind: "pdf" | "foto"; name: string };
  /** Contact cards shared in the message. `phone` is null when a card has no usable number. */
  contacts?: Array<{ name: string; phone: string | null }>;
}

export type MessageHandler = (message: InboundMessage) => Promise<void>;

export interface Channel {
  send(toPhone: string, text: string): Promise<{ id: string }>;
  onMessage(handler: MessageHandler): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Resolves when a send can succeed. Missing means the channel is already open. */
  whenReady?(): Promise<void>;
}
