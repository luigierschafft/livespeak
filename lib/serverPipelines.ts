import OpenAI, { toFile } from 'openai';
import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import { spawnSync } from 'child_process';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegPath: string = require('ffmpeg-static');

export type PipelineVariant =
  | 'azure-v2v'
  | 'azure-v2v-fast'
  | 'azure-v2v-stream'
  | 'azure-v2v-synthesizing'
  | 'azure-v2v-fix2'
  | 'azure-v2v-silence500'
  | 'azure-v2v-smooth'
  | 'azure-v2v-smooth-filtered'
  | 'azure-v2v-preconnect'
  | 'whisper-azure-azure'
  | 'whisper-gpt4mini-azure'
  | 'whisper-gpt4o-azure';

export type Lang = 'ta' | 'fr' | 'de';

export interface PipelineHandler {
  pushChunk(buffer: Buffer): void;
  stop(): Promise<void>;
}

export const PIPELINE_LABELS: Record<PipelineVariant, string> = {
  'azure-v2v':              'Azure Voice-to-Voice',
  'azure-v2v-fast':         'Azure V2V Fast (300ms Pause)',
  'azure-v2v-stream':       'Azure V2V Stream (max 5s Segmente)',
  'azure-v2v-synthesizing': 'Azure V2V Fix1 — Sofort-Stream (synthesizing)',
  'azure-v2v-fix2':         'Azure V2V Fix2 — 300ms Pause + korrekter Segment-Property',
  'azure-v2v-silence500':   'Azure V2V Silence Fix — 500ms Segmentierung',
  'azure-v2v-smooth':         'Azure V2V Smooth — 400ms gebufferter Stream',
  'azure-v2v-smooth-filtered':'Azure V2V Smooth Filtered — 400ms + Anti-Halluzination',
  'azure-v2v-preconnect':     'Azure V2V Preconnect — Vorgeöffnete Verbindung',
  'whisper-azure-azure':    'Whisper + Azure Translator + Azure TTS  (Rang 1 — 8s)',
  'whisper-gpt4mini-azure': 'Whisper + GPT-4o-mini + Azure TTS       (Rang 2 — 12s)',
  'whisper-gpt4o-azure':    'Whisper + GPT-4o + Azure TTS            (Rang 3 — 12.5s)',
};

const AZURE_VOICES: Record<Lang, string> = {
  ta: 'ta-IN-PallaviNeural',
  fr: 'fr-FR-DeniseNeural',
  de: 'de-DE-ConradNeural',
};

const LANGUAGE_NAMES: Record<Lang, string> = {
  ta: 'Tamil',
  fr: 'French',
  de: 'German',
};

function convertWebMToPCM(buffer: Buffer): Buffer {
  const result = spawnSync(ffmpegPath, [
    '-y', '-i', 'pipe:0', '-ar', '16000', '-ac', '1', '-f', 's16le', 'pipe:1',
  ], { input: buffer, maxBuffer: 50 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr?.toString()}`);
  return result.stdout as Buffer;
}

async function azureTTS(text: string, lang: Lang): Promise<Buffer> {
  const config = sdk.SpeechConfig.fromSubscription(
    process.env.AZURE_SPEECH_KEY!,
    process.env.AZURE_SPEECH_REGION!,
  );
  config.speechSynthesisVoiceName = AZURE_VOICES[lang];
  config.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio16Khz32KBitRateMonoMp3;

  return new Promise((resolve, reject) => {
    const synth = new sdk.SpeechSynthesizer(config, undefined as unknown as sdk.AudioConfig);
    synth.speakTextAsync(
      text,
      (r) => {
        synth.close();
        if (r.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
          resolve(Buffer.from(r.audioData));
        } else {
          reject(new Error(`Azure TTS failed: ${r.errorDetails}`));
        }
      },
      (e) => { synth.close(); reject(new Error(`Azure TTS error: ${e}`)); },
    );
  });
}

async function azureTranslateMulti(text: string, langs: Lang[]): Promise<Map<Lang, string>> {
  const toParams = langs.map(l => `to=${l}`).join('&');
  const resp = await fetch(
    `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en&${toParams}`,
    {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': process.env.AZURE_TRANSLATOR_KEY!,
        'Ocp-Apim-Subscription-Region': process.env.AZURE_TRANSLATOR_REGION || 'westeurope',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([{ text }]),
    },
  );
  if (!resp.ok) throw new Error(`Azure Translator failed: ${resp.status}`);
  const data = await resp.json() as Array<{ translations: Array<{ text: string; to: string }> }>;
  const result = new Map<Lang, string>();
  for (const t of data[0]?.translations ?? []) {
    if (langs.includes(t.to as Lang)) result.set(t.to as Lang, t.text);
  }
  return result;
}

async function gptTranslateMulti(
  openai: OpenAI,
  model: string,
  text: string,
  langs: Lang[],
): Promise<Map<Lang, string>> {
  const results = await Promise.allSettled(langs.map(async (lang) => {
    const r = await openai.chat.completions.create({
      model,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: `You are a professional interpreter. Translate the following English text to ${LANGUAGE_NAMES[lang]}. Output only the translation, no explanations.`,
        },
        { role: 'user', content: text },
      ],
    });
    return { lang, text: r.choices[0]?.message?.content?.trim() ?? '' };
  }));
  const map = new Map<Lang, string>();
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.text) map.set(r.value.lang, r.value.text);
  }
  return map;
}

// ── Azure Voice-to-Voice ─────────────────────────────────────────────────────

interface AzureV2VOptions {
  endSilenceMs?: number;
  maxSegmentMs?: number;
  segmentationSilenceMs?: number; // Speech_SegmentationSilenceTimeoutMs — phrase-level silence
  streamOnSynthesizing?: boolean; // Fix1: send audio immediately per synthesizing chunk
  flushIntervalMs?: number;       // Smooth: buffer synthesizing chunks, flush every N ms
  validateWithRecognized?: boolean; // Smooth-Filtered: discard chunks if no valid speech detected
  preConnect?: boolean;           // Pre-open Azure WebSocket before first audio chunk arrives
}

function createAzureV2VHandler(
  targetLangs: Lang[],
  onAudio: (lang: Lang, buf: Buffer) => void,
  onError: (err: Error) => void,
  options: AzureV2VOptions = {},
): PipelineHandler {
  const recognizers = new Map<Lang, {
    recognizer: sdk.TranslationRecognizer;
    pushStream: sdk.PushAudioInputStream;
    audioChunks: Buffer[];
    flushInterval: NodeJS.Timeout | null;
  }>();

  for (const lang of targetLangs) {
    const config = sdk.SpeechTranslationConfig.fromSubscription(
      process.env.AZURE_SPEECH_KEY!,
      process.env.AZURE_SPEECH_REGION!,
    );
    config.speechRecognitionLanguage = 'en-US';
    config.addTargetLanguage(lang);
    config.voiceName = AZURE_VOICES[lang];

    if (options.endSilenceMs !== undefined) {
      config.setProperty(sdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs, String(options.endSilenceMs));
    }
    if (options.maxSegmentMs !== undefined) {
      config.setProperty(sdk.PropertyId.Speech_SegmentationMaximumTimeMs, String(options.maxSegmentMs));
    }
    if (options.segmentationSilenceMs !== undefined) {
      // Phrase-level silence: fires recognized after N ms of silence within a segment
      config.setProperty(sdk.PropertyId.Speech_SegmentationSilenceTimeoutMs, String(options.segmentationSilenceMs));
    }

    const pushStream = sdk.AudioInputStream.createPushStream(
      sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1),
    );
    const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
    const recognizer = new sdk.TranslationRecognizer(config, audioConfig);
    const audioChunks: Buffer[] = [];
    let hasValidSpeech = false;

    // Smooth mode: flush buffered synthesizing chunks every N ms
    let flushInterval: NodeJS.Timeout | null = null;
    if (options.flushIntervalMs) {
      flushInterval = setInterval(() => {
        if (options.validateWithRecognized && !hasValidSpeech) {
          audioChunks.splice(0); // discard — no valid speech confirmed yet
          return;
        }
        const chunks = audioChunks.splice(0);
        if (chunks.length > 0) onAudio(lang, Buffer.concat(chunks));
      }, options.flushIntervalMs);
    }

    // Pre-open Azure WebSocket connection before first audio chunk arrives
    if (options.preConnect) {
      const connection = sdk.Connection.fromRecognizer(recognizer);
      connection.openConnection();
    }

    recognizer.synthesizing = (_, e) => {
      if (e.result.audio && e.result.audio.byteLength > 0) {
        if (options.streamOnSynthesizing) {
          // Fix1: send each chunk immediately as it arrives — no waiting for recognized
          onAudio(lang, Buffer.from(e.result.audio));
        } else {
          audioChunks.push(Buffer.from(e.result.audio));
        }
      }
    };

    recognizer.recognized = (_, e) => {
      if (options.streamOnSynthesizing) return; // already sent in synthesizing
      if (options.validateWithRecognized) {
        // Update validity flag and optionally discard hallucinated audio
        if (e.result.reason === sdk.ResultReason.TranslatedSpeech && e.result.text.trim().length > 3) {
          hasValidSpeech = true;
        } else if (e.result.reason === sdk.ResultReason.NoMatch) {
          hasValidSpeech = false;
          audioChunks.splice(0); // discard hallucinated audio immediately
        }
        return; // flushing is handled by the interval
      }
      if (options.flushIntervalMs) return; // already flushed by interval
      const chunks = audioChunks.splice(0);
      if (e.result.reason === sdk.ResultReason.TranslatedSpeech && chunks.length > 0) {
        onAudio(lang, Buffer.concat(chunks));
      }
    };

    recognizer.canceled = (_, e) => {
      if (e.reason === sdk.CancellationReason.Error) {
        onError(new Error(`Azure V2V (${lang}) canceled: ${e.errorDetails}`));
      }
    };

    recognizer.startContinuousRecognitionAsync(
      () => console.log(`[pipeline] Azure V2V started for ${lang}`),
      (err) => onError(new Error(`Azure V2V start failed (${lang}): ${err}`)),
    );

    recognizers.set(lang, { recognizer, pushStream, audioChunks, flushInterval });
  }

  return {
    pushChunk(buffer: Buffer): void {
      try {
        const pcm = convertWebMToPCM(buffer);
        for (const { pushStream } of recognizers.values()) {
          pushStream.write(pcm.buffer as ArrayBuffer);
        }
      } catch (err) {
        onError(err as Error);
      }
    },
    async stop(): Promise<void> {
      for (const { recognizer, pushStream, flushInterval } of recognizers.values()) {
        try {
          if (flushInterval) clearInterval(flushInterval);
          pushStream.close();
          await new Promise<void>((resolve) => {
            recognizer.stopContinuousRecognitionAsync(
              () => { recognizer.close(); resolve(); },
              () => { recognizer.close(); resolve(); },
            );
          });
        } catch { /* ignore cleanup errors */ }
      }
    },
  };
}

// ── Whisper-based pipelines ──────────────────────────────────────────────────

function createWhisperBasedHandler(
  variant: 'whisper-azure-azure' | 'whisper-gpt4mini-azure' | 'whisper-gpt4o-azure',
  targetLangs: Lang[],
  onAudio: (lang: Lang, buf: Buffer) => void,
  onError: (err: Error) => void,
): PipelineHandler {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  return {
    pushChunk(buffer: Buffer): void {
      (async () => {
        try {
          // 1. Whisper STT
          const audioFile = await toFile(buffer, 'chunk.webm', { type: 'audio/webm' });
          const transcription = await openai.audio.transcriptions.create({
            file: audioFile,
            model: 'whisper-1',
            language: 'en',
          });
          const text = transcription.text.trim();
          if (!text) return;
          console.log(`[pipeline] STT (${variant}): "${text}"`);

          // 2. Translate all languages
          let translations: Map<Lang, string>;
          if (variant === 'whisper-azure-azure') {
            translations = await azureTranslateMulti(text, targetLangs);
          } else {
            const model = variant === 'whisper-gpt4o-azure' ? 'gpt-4o' : 'gpt-4o-mini';
            translations = await gptTranslateMulti(openai, model, text, targetLangs);
          }

          // 3. Azure TTS for each language in parallel
          await Promise.allSettled(targetLangs.map(async (lang) => {
            const translated = translations.get(lang);
            if (!translated) return;
            console.log(`[pipeline] TTS (${lang}): "${translated}"`);
            const audio = await azureTTS(translated, lang);
            onAudio(lang, audio);
          }));
        } catch (err) {
          onError(err as Error);
        }
      })();
    },
    async stop(): Promise<void> {
      // no cleanup needed
    },
  };
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createPipelineHandler(
  variant: PipelineVariant,
  targetLangs: Lang[],
  onAudio: (lang: Lang, buf: Buffer) => void,
  onError: (err: Error) => void,
): PipelineHandler {
  console.log(`[pipeline] Creating pipeline: ${variant} for langs: [${targetLangs.join(', ')}]`);
  if (variant === 'azure-v2v') {
    return createAzureV2VHandler(targetLangs, onAudio, onError);
  }
  if (variant === 'azure-v2v-fast') {
    return createAzureV2VHandler(targetLangs, onAudio, onError, { endSilenceMs: 300 });
  }
  if (variant === 'azure-v2v-stream') {
    return createAzureV2VHandler(targetLangs, onAudio, onError, { endSilenceMs: 300, maxSegmentMs: 5000 });
  }
  if (variant === 'azure-v2v-synthesizing') {
    // Fix1: stream audio immediately per synthesizing event, no buffering until recognized
    return createAzureV2VHandler(targetLangs, onAudio, onError, { streamOnSynthesizing: true });
  }
  if (variant === 'azure-v2v-fix2') {
    return createAzureV2VHandler(targetLangs, onAudio, onError, { endSilenceMs: 300, maxSegmentMs: 5000, streamOnSynthesizing: true });
  }
  if (variant === 'azure-v2v-silence500') {
    // Correct phrase-level silence property — fires recognized after 500ms of silence
    return createAzureV2VHandler(targetLangs, onAudio, onError, { segmentationSilenceMs: 500 });
  }
  if (variant === 'azure-v2v-smooth') {
    // Buffer synthesizing chunks, flush every 400ms — smoother than Fix1, faster than recognized
    return createAzureV2VHandler(targetLangs, onAudio, onError, { flushIntervalMs: 400 });
  }
  if (variant === 'azure-v2v-smooth-filtered') {
    // Smooth 400ms + discard audio when no valid speech detected (anti-hallucination)
    return createAzureV2VHandler(targetLangs, onAudio, onError, { flushIntervalMs: 400, validateWithRecognized: true });
  }
  if (variant === 'azure-v2v-preconnect') {
    // Standard V2V quality + pre-open Azure connection to reduce startup latency
    return createAzureV2VHandler(targetLangs, onAudio, onError, { preConnect: true });
  }
  return createWhisperBasedHandler(variant, targetLangs, onAudio, onError);
}
