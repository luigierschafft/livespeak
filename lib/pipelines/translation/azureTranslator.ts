export async function translateAzure(text: string): Promise<{ text: string; durationMs: number }> {
  const start = Date.now();

  const key = process.env.AZURE_TRANSLATOR_KEY!;
  const region = process.env.AZURE_TRANSLATOR_REGION!;

  const response = await fetch(
    'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en&to=de',
    {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Ocp-Apim-Subscription-Region': region,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([{ text }]),
    }
  );

  if (!response.ok) {
    throw new Error(`Azure Translator failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json() as Array<{ translations: Array<{ text: string }> }>;
  const translated = data[0]?.translations[0]?.text ?? '';
  return { text: translated, durationMs: Date.now() - start };
}
