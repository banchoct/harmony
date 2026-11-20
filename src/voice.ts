/**
 * whisper-1 accepts WhatsApp .ogg/opus as sent. Newer transcribe models
 * often require a conversion this process does not do.
 */
const DEFAULT_TRANSCRIBE_MODEL = "whisper-1";

/** OpenAI rejects audio above this size. It is a size limit, not a duration. */
export const WHISPER_MAX_BYTES = 25 * 1024 * 1024;

export interface Transcriber {
  transcribe(audio: { bytes: Uint8Array; mimeType: string }): Promise<string>;
}

export function exceedsWhisperLimit(byteLength: number): boolean {
  return Number.isFinite(byteLength) && byteLength > WHISPER_MAX_BYTES;
}

export function createOpenAITranscriber(options: {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
}): Transcriber {
  const fetchImpl = options.fetchImpl ?? fetch;
  const model = options.model?.trim() || DEFAULT_TRANSCRIBE_MODEL;
  return {
    async transcribe(audio) {
      return transcribeWithOpenAI({
        apiKey: options.apiKey,
        model,
        bytes: audio.bytes,
        mimeType: audio.mimeType,
        fetchImpl,
      });
    },
  };
}

async function transcribeWithOpenAI(input: {
  apiKey: string;
  model: string;
  bytes: Uint8Array;
  mimeType: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY_MISSING");
  if (exceedsWhisperLimit(input.bytes.byteLength)) throw new Error("AUDIO_TOO_LARGE");
  const fetchImpl = input.fetchImpl ?? fetch;
  const form = new FormData();
  const bytes = new Uint8Array(input.bytes);
  form.append("file", new Blob([bytes], { type: input.mimeType }), fileName(input.mimeType));
  form.append("model", input.model);
  form.append("language", "es");
  const response = await fetchImpl(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) throw new Error(`TRANSCRIBE_FAILED ${response.status}`);
  const body = (await response.json()) as { text?: unknown };
  if (typeof body.text !== "string" || body.text.trim().length === 0) {
    throw new Error("TRANSCRIBE_EMPTY");
  }
  return body.text.trim();
}

const ALLOWED_SHORT = new Set(["si", "no", "ya", "ok", "va"]);

const NOISE_WORD = new Set([
  "musica",
  "music",
  "aplausos",
  "silencio",
  "risas",
  "applause",
  "silence",
  "fondo",
  "background",
  "de",
  "y",
  "ah",
  "eh",
  "um",
  "hmm",
  "mm",
  "mmm",
  "oh",
  "ooh",
]);

const HALLUCINATION = [
  /amara\.org/,
  /subtitulos realizados/,
  // Whisper cierra con punto o exclamación. fold() no quita esa puntuación.
  /thanks for watching[^a-z0-9]*$/,
  /gracias por ver(?:lo| el video| este video| el canal)?[^a-z0-9]*$/,
  /suscribete/,
  /like and subscribe/,
];

/**
 * Whisper writes "[Música]", silence, or stock outros when the note is
 * noise, a song, or a forward with no speech. Those strings are not what
 * the person said. A short real answer (sí, no, ya, ok) stays.
 * Returns the trimmed transcript, or null when it should not be used.
 */
export function usableTranscript(text: string): string | null {
  const clean = text.trim();
  if (!clean) return null;
  const folded = fold(clean);
  if (HALLUCINATION.some((pattern) => pattern.test(folded))) return null;
  const words = folded.match(/[a-z0-9]+/g) ?? [];
  if (words.length === 0) return null;
  const said = words.filter((word) => !NOISE_WORD.has(word));
  if (said.length === 0) return null;
  if (said.every((word) => word.length < 2) && !said.some((word) => ALLOWED_SHORT.has(word))) {
    return null;
  }
  return clean;
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function fileName(mimeType: string): string {
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "nota.mp3";
  if (mimeType.includes("wav")) return "nota.wav";
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "nota.m4a";
  return "nota.ogg";
}
