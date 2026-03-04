import OpenAI, { toFile } from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const LANGUAGE_NAMES: Record<string, string> = {
  ta: 'Tamil',
  fr: 'French',
  de: 'German',
};

export async function processChunk(
  audioBuffer: Buffer,
  targetLangs: ('ta' | 'fr' | 'de')[]
): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();

  // Step 1: Whisper STT
  console.log(`[2] Whisper STT start — chunk size: ${audioBuffer.length} bytes`);
  const audioFile = await toFile(audioBuffer, 'chunk.webm', { type: 'audio/webm' });
  const transcription = await openai.audio.transcriptions.create({
    file: audioFile,
    model: 'whisper-1',
    language: 'en',
  });

  const text = transcription.text.trim();
  console.log(`[2] Whisper result: "${text || '(empty — silent chunk, skipping)'}"`);

  if (!text) {
    return result;
  }

  // Step 2 + 3: Translate + TTS in parallel per language
  const settled = await Promise.allSettled(
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
      console.log(`[3] GPT translation (${lang}): "${translatedText}"`);
      if (!translatedText) return;

      // TTS
      const speechResponse = await openai.audio.speech.create({
        model: 'tts-1',
        voice: 'alloy',
        input: translatedText,
        response_format: 'mp3',
      });

      const audioData = Buffer.from(await speechResponse.arrayBuffer());
      console.log(`[4] TTS done (${lang}): ${audioData.length} bytes MP3`);
      result.set(lang, audioData);
    })
  );

  settled.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[3] Pipeline failed for lang=${targetLangs[i]}:`, r.reason?.message ?? r.reason);
    }
  });

  return result;
}
