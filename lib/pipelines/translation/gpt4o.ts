import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function translateGPT4o(text: string): Promise<{ text: string; durationMs: number }> {
  const start = Date.now();

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content: 'You are a professional interpreter. Translate the following English text to German. Output only the translation, no explanations.',
      },
      { role: 'user', content: text },
    ],
  });

  const translated = response.choices[0]?.message?.content?.trim() ?? '';
  return { text: translated, durationMs: Date.now() - start };
}
