import OpenAI, { toFile } from 'openai';
import * as fs from 'fs';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function whisperSTT(audioPath: string): Promise<{ text: string; durationMs: number }> {
  const start = Date.now();
  const audioBuffer = fs.readFileSync(audioPath);
  const audioFile = await toFile(audioBuffer, 'audio.mp3', { type: 'audio/mpeg' });

  const response = await openai.audio.transcriptions.create({
    file: audioFile,
    model: 'whisper-1',
    language: 'en',
  });

  return { text: response.text.trim(), durationMs: Date.now() - start };
}
