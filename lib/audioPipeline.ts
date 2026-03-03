import OpenAI from 'openai';
import { Readable } from 'stream';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const LANGUAGE_NAMES: Record<string, string> = {
  ta: 'Tamil',
  fr: 'French',
};

export async function processChunk(
  audioBuffer: Buffer,
  targetLangs: ('ta' | 'fr')[]
): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();

  // Step 1: Whisper STT
  const audioFile = new File([new Uint8Array(audioBuffer)], 'chunk.webm', { type: 'audio/webm' });
  const transcription = await openai.audio.transcriptions.create({
    file: audioFile,
    model: 'whisper-1',
    language: 'en',
  });

  const text = transcription.text.trim();

  // Skip silent/empty chunks
  if (!text) {
    return result;
  }

  // Step 2 + 3: Translate + TTS in parallel per language
  await Promise.all(
    targetLangs.map(async (lang) => {
      const langName = LANGUAGE_NAMES[lang];

      // GPT-4o translation
      const translationResponse = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: `You are a professional interpreter. Translate the following English text to ${langName}. Output only the translation, no explanations.`,
          },
          { role: 'user', content: text },
        ],
        temperature: 0.2,
      });

      const translatedText = translationResponse.choices[0]?.message?.content?.trim();
      if (!translatedText) return;

      // TTS
      const speechResponse = await openai.audio.speech.create({
        model: 'tts-1-hd',
        voice: 'alloy',
        input: translatedText,
        response_format: 'mp3',
      });

      const audioData = Buffer.from(await speechResponse.arrayBuffer());
      result.set(lang, audioData);
    })
  );

  return result;
}
