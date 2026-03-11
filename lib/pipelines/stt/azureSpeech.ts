import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegPath: string = require('ffmpeg-static');

export type AzureSTTMode = 'default' | 'dictation' | 'conversation';

function convertToPCM(audioPath: string): Buffer {
  const result = spawnSync(ffmpegPath, [
    '-y', '-i', audioPath,
    '-ar', '16000', '-ac', '1', '-f', 's16le', 'pipe:1',
  ], { maxBuffer: 200 * 1024 * 1024 });

  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr?.toString()}`);
  return result.stdout as Buffer;
}

export async function azureSTT(
  audioPath: string,
  mode: AzureSTTMode
): Promise<{ text: string; durationMs: number }> {
  const start = Date.now();

  const speechKey = process.env.AZURE_SPEECH_KEY!;
  const speechRegion = process.env.AZURE_SPEECH_REGION!;

  const config = sdk.SpeechConfig.fromSubscription(speechKey, speechRegion);
  config.speechRecognitionLanguage = 'en-US';

  if (mode === 'dictation') {
    config.enableDictation();
  } else if (mode === 'conversation') {
    // Shorter end-of-speech silence for faster sentence-end detection
    config.setProperty(
      sdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs, '500'
    );
    config.setProperty(
      sdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs, '5000'
    );
  }

  const pcmData = convertToPCM(audioPath);
  const pushStream = sdk.AudioInputStream.createPushStream(
    sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1)
  );
  pushStream.write(pcmData.buffer as ArrayBuffer);
  pushStream.close();

  const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
  const recognizer = new sdk.SpeechRecognizer(config, audioConfig);

  return new Promise((resolve, reject) => {
    const parts: string[] = [];

    recognizer.recognized = (_, e) => {
      if (e.result.reason === sdk.ResultReason.RecognizedSpeech && e.result.text) {
        parts.push(e.result.text);
      }
    };

    recognizer.sessionStopped = () => {
      recognizer.stopContinuousRecognitionAsync();
      resolve({ text: parts.join(' ').trim(), durationMs: Date.now() - start });
    };

    recognizer.canceled = (_, e) => {
      recognizer.stopContinuousRecognitionAsync();
      if (e.reason === sdk.CancellationReason.Error) {
        reject(new Error(`Azure STT canceled: ${e.errorDetails}`));
      } else {
        resolve({ text: parts.join(' ').trim(), durationMs: Date.now() - start });
      }
    };

    recognizer.startContinuousRecognitionAsync(
      () => { /* started */ },
      (err) => reject(new Error(`Azure STT start failed: ${err}`))
    );
  });
}
