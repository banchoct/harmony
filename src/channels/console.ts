import { randomUUID } from "node:crypto";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Channel, MessageHandler } from "../channel.js";

/** A console line is the sender's phone, a space, and the text: `+5215500000002 hola`. */
export function parseConsoleLine(line: string): { phone: string; text: string } | null {
  const match = /^(\+\d+)\s+(\S[\s\S]*)$/.exec(line.trim());
  if (!match?.[1] || !match[2]) return null;
  return { phone: match[1], text: match[2] };
}

export interface ConsoleChannel extends Channel {
  /** Resolves when the input has ended and every line read has been handled. */
  finished: Promise<void>;
}

/**
 * `onCommand` gets every line that is not a message and returns what to print, or null when
 * the line means nothing to it.
 */
export function createConsoleChannel(
  io?: { input?: Readable; output?: Writable },
  onCommand?: (line: string) => Promise<string | null>,
): ConsoleChannel {
  const input = io?.input ?? process.stdin;
  const output = io?.output ?? process.stdout;
  let handler: MessageHandler | null = null;
  let reader: Interface | null = null;
  let queue: Promise<void> = Promise.resolve();
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => (finish = resolve));

  return {
    finished,
    onMessage(next) {
      handler = next;
    },
    async send(toPhone, text) {
      output.write(`-> ${toPhone} ${text}\n`);
      return { id: randomUUID() };
    },
    async start() {
      reader = createInterface({ input });
      reader.on("line", (line) => {
        const parsed = parseConsoleLine(line);
        // One line at a time, in the order typed.
        queue = queue.then(async () => {
          try {
            if (parsed) {
              if (!handler) throw new Error("NO_HANDLER");
              await handler({
                id: randomUUID(),
                fromPhone: parsed.phone,
                text: parsed.text,
                receivedAt: new Date().toISOString(),
              });
            } else if (line.trim()) {
              const answer = await onCommand?.(line.trim());
              output.write(`${answer ?? "?? Escribe el teléfono y luego el mensaje: +5215500000002 hola"}\n`);
            }
          } catch (error) {
            output.write(`!! No se pudo procesar el mensaje: ${error instanceof Error ? error.message : error}\n`);
          }
        });
      });
      reader.on("close", () => void queue.then(finish));
    },
    async stop() {
      if (!reader) return;
      reader.close();
      await finished;
    },
  };
}
