import { handleMessage, type TurnDeps } from "./turn.js";

/**
 * Wires Harmony to a channel: every inbound message becomes one turn. Turns run one at a time,
 * in the order the messages arrived, so two messages landing together cannot interleave.
 */
export function createHarmony(deps: TurnDeps): void {
  let queue: Promise<void> = Promise.resolve();
  deps.channel.onMessage((message) => {
    const turn = queue.then(() => handleMessage(deps, message));
    queue = turn.catch(() => undefined);
    return turn;
  });
}
