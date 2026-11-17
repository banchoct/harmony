import type { Channel, MessageHandler } from "../channel.js";

export interface FakeChannel extends Channel {
  /** Delivers a message as if it had arrived from that phone. */
  receive(fromPhone: string, text: string): Promise<void>;
  sent: Array<{ toPhone: string; text: string; id: string }>;
}

export function createFakeChannel(): FakeChannel {
  let handler: MessageHandler | null = null;
  const sent: FakeChannel["sent"] = [];
  let sequence = 0;
  return {
    sent,
    onMessage(next) {
      handler = next;
    },
    async send(toPhone, text) {
      const id = `fake-out-${++sequence}`;
      sent.push({ toPhone, text, id });
      return { id };
    },
    async start() {},
    async stop() {},
    async receive(fromPhone, text) {
      if (!handler) throw new Error("NO_HANDLER");
      await handler({
        id: `fake-in-${++sequence}`,
        fromPhone,
        text,
        receivedAt: new Date().toISOString(),
      });
    },
  };
}
