import { test } from "node:test";
import assert from "node:assert/strict";
import { createOpenAITranscriber } from "../src/voice.js";

const audio = { bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/ogg" };

test("the transcriber sends the audio with the key in the header and returns the words", async () => {
  const seen: Array<{ url: string; auth: string | null; model: unknown; language: unknown }> = [];
  const transcriber = createOpenAITranscriber({
    apiKey: "test-key",
    fetchImpl: async (url, init) => {
      const form = init?.body as FormData;
      seen.push({
        url: String(url),
        auth: new Headers(init?.headers).get("authorization"),
        model: form.get("model"),
        language: form.get("language"),
      });
      return new Response(JSON.stringify({ text: " ¿Qué días sale la basura? " }));
    },
  });
  assert.equal(await transcriber.transcribe(audio), "¿Qué días sale la basura?");
  assert.deepEqual(seen, [
    { url: "https://api.openai.com/v1/audio/transcriptions", auth: "Bearer test-key", model: "whisper-1", language: "es" },
  ]);
});

test("a failed or empty transcription is an error, never empty words", async () => {
  const failing = createOpenAITranscriber({ apiKey: "test-key", fetchImpl: async () => new Response("no", { status: 500 }) });
  await assert.rejects(failing.transcribe(audio), /TRANSCRIBE_FAILED 500/);
  const empty = createOpenAITranscriber({ apiKey: "test-key", fetchImpl: async () => new Response(JSON.stringify({ text: " " })) });
  await assert.rejects(empty.transcribe(audio), /TRANSCRIBE_EMPTY/);
});

test("without a key nothing is sent", async () => {
  let calls = 0;
  const transcriber = createOpenAITranscriber({ apiKey: " ", fetchImpl: async () => (calls++, new Response("{}")) });
  await assert.rejects(transcriber.transcribe(audio), /OPENAI_API_KEY_MISSING/);
  assert.equal(calls, 0);
});
