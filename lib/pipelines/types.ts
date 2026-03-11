export interface PipelineResult {
  name: string;
  sttMethod: string;
  translationMethod: string;
  ttsMethod: string;
  transcript: string;
  translatedText: string;
  audioBuffer: Buffer | null;
  totalMs: number;
  sttMs: number;
  translationMs: number;
  ttsMs: number;
  error?: string;
}

export type STTFn = (audioPath: string) => Promise<{ text: string; durationMs: number }>;
export type TranslateFn = (text: string) => Promise<{ text: string; durationMs: number }>;
export type TTSFn = (text: string) => Promise<{ audio: Buffer; durationMs: number }>;

export interface PipelineConfig {
  name: string;
  sttMethod: string;
  translationMethod: string;
  ttsMethod: string;
  stt: STTFn;
  translate: TranslateFn;
  tts: TTSFn;
}
