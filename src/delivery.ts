import type { Channel } from "./channel.js";
import type { Db } from "./db.js";
import { recordEvent } from "./log.js";

/** An answer that arrives a day late does more harm than none. */
const GIVE_UP_AFTER = "24 hours";

/** Stores a message for a person. It is sent by the next deliverPending. */
export async function enqueue(db: Db, personId: string, body: string): Promise<void> {
  await db.query("INSERT INTO messages (person_id, direction, body) VALUES ($1, 'out', $2)", [personId, body]);
}

/** Deliveries on one database run one after another, so two never send the same message. */
const running = new WeakMap<Db, Promise<void>>();

/**
 * Sends every stored message not yet sent to people still in the house, oldest first. A message
 * the channel refuses, or does not finish sending in time, stays stored for the next call and
 * holds back later ones to the same person so order is kept. One that has waited a day is given
 * up and logged.
 */
export function deliverPending(db: Db, channel: Channel, options: { sendTimeoutMs?: number } = {}): Promise<void> {
  const run = (running.get(db) ?? Promise.resolve()).then(() =>
    deliverOnce(db, channel, options.sendTimeoutMs ?? 60_000),
  );
  running.set(db, run.catch(() => undefined));
  return run;
}

/** The channel's send, abandoned after a while: a send that hangs must not hold every turn. */
async function sendInTime(channel: Channel, phone: string, body: string, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      channel.send(phone, body),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("SEND_TIMEOUT")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function deliverOnce(db: Db, channel: Channel, sendTimeoutMs: number): Promise<void> {
  const abandoned = await db.query<{ id: string; person_id: string }>(
    `UPDATE messages SET abandoned_at = now()
     WHERE direction = 'out' AND sent_at IS NULL AND abandoned_at IS NULL
       AND created_at < now() - interval '${GIVE_UP_AFTER}'
     RETURNING id, person_id`,
  );
  for (const message of abandoned) {
    await recordEvent(db, "delivery_abandoned", message.person_id, { message_id: message.id });
  }
  const unsent = await db.query<{ id: string; body: string; phone: string }>(
    `SELECT messages.id, messages.body, people.phone
     FROM messages JOIN people ON people.id = messages.person_id
     WHERE direction = 'out' AND sent_at IS NULL AND abandoned_at IS NULL AND people.active AND people.phone IS NOT NULL
     ORDER BY messages.seq`,
  );
  const blocked = new Set<string>();
  for (const message of unsent) {
    if (blocked.has(message.phone)) continue;
    try {
      await sendInTime(channel, message.phone, message.body, sendTimeoutMs);
    } catch (error) {
      blocked.add(message.phone);
      await db.query("UPDATE messages SET attempts = attempts + 1, last_error = $2 WHERE id = $1", [
        message.id,
        error instanceof Error ? error.message : String(error),
      ]);
      continue;
    }
    await db.query("UPDATE messages SET sent_at = now() WHERE id = $1", [message.id]);
  }
}
