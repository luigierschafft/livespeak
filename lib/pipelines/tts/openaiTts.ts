import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function openaiTTS(text: string): Promise<{ audio: Buffer; durationMs: number }> {
  const start = Date.now();

  const response = await openai.audio.speech.create({
    model: 'tts-1',
    voice: 'alloy',
    input: text,
    response_format: 'mp3',
  });

  const audio = Buffer.from(await response.arrayBuffer());
  return { audio, durationMs: Date.now() - start };
}
