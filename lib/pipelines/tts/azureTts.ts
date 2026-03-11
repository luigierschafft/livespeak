import * as sdk from 'microsoft-cognitiveservices-speech-sdk';

export async function azureTTS(text: string): Promise<{ audio: Buffer; durationMs: number }> {
  const start = Date.now();

  const config = sdk.SpeechConfig.fromSubscription(
    process.env.AZURE_SPEECH_KEY!,
    process.env.AZURE_SPEECH_REGION!
  );
  config.speechSynthesisVoiceName = 'de-DE-ConradNeural';
  config.speechSynthesisOutputFormat =
    sdk.SpeechSynthesisOutputFormat.Audio24Khz160KBitRateMonoMp3;

  return new Promise((resolve, reject) => {
    const synthesizer = new sdk.SpeechSynthesizer(config, undefined as unknown as sdk.AudioConfig);

    synthesizer.speakTextAsync(
      text,
      (result) => {
        synthesizer.close();
        if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
          resolve({ audio: Buffer.from(result.audioData), durationMs: Date.now() - start });
        } else {
          reject(new Error(`Azure TTS failed: ${result.errorDetails}`));
        }
      },
      (err) => {
        synthesizer.close();
        reject(new Error(`Azure TTS error: ${err}`));
      }
    );
  });
}
