import { handleMessage, type TurnDeps } from "./turn.js";

/** Wires Harmony to a channel: every inbound message becomes one turn. */
export function createHarmony(deps: TurnDeps): void {
  deps.channel.onMessage((message) => handleMessage(deps, message));
}
