'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { use } from 'react';

type Lang = 'ta' | 'fr' | 'de';
type Status = 'select_lang' | 'waiting' | 'playing' | 'ended' | 'error';

const LANG_LABELS: Record<Lang, string> = {
  ta: 'Tamil',
  fr: 'Français',
  de: 'Deutsch',
};

const MAX_RECONNECT_ATTEMPTS = 3;

export default function ListenPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = use(params);

  const [status, setStatus] = useState<Status>('select_lang');
  const [lang, setLang] = useState<Lang | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [reconnectCount, setReconnectCount] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioQueueRef = useRef<ArrayBuffer[]>([]);
  const isPlayingRef = useRef(false);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectCountRef = useRef(0);

  const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8080';

  const playNextChunk = useCallback(async () => {
    if (isPlayingRef.current || audioQueueRef.current.length === 0) return;
    const ctx = audioCtxRef.current;
    if (!ctx) return;

    isPlayingRef.current = true;
    const buf = audioQueueRef.current.shift()!;

    try {
      // Resume context if browser auto-suspended it (e.g. tab was backgrounded)
      if (ctx.state === 'suspended') {
        console.log('[8] AudioContext was suspended — resuming...');
        await ctx.resume();
      }
      console.log(`[8] decodeAudioData — buf size: ${buf.byteLength} bytes, ctx state: ${ctx.state}`);
      const decoded = await ctx.decodeAudioData(buf);
      console.log(`[9] Decoded OK — duration: ${decoded.duration.toFixed(2)}s, playing now`);
      const source = ctx.createBufferSource();
      source.buffer = decoded;
      source.connect(ctx.destination);
      source.onended = () => {
        console.log('[9] Chunk ended, queue remaining:', audioQueueRef.current.length);
        isPlayingRef.current = false;
        playNextChunk();
      };
      source.start();
    } catch (err) {
      console.error('[8] Audio decode error:', err);
      isPlayingRef.current = false;
      playNextChunk();
    }
  }, []);

  const connectWS = useCallback(
    (selectedLang: Lang) => {
      if (wsRef.current) {
        wsRef.current.close();
      }

      const ws = new WebSocket(
        `${WS_URL}/listen?sessionId=${sessionId}&lang=${selectedLang}`
      );
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('Listener WS connected');
        reconnectCountRef.current = 0;
        setReconnectCount(0);
      };

      ws.onmessage = async (event) => {
        if (event.data instanceof Blob) {
          // Binary audio chunk
          const buf = await event.data.arrayBuffer();
          console.log(`[7] Binary received: ${buf.byteLength} bytes, queue length before push: ${audioQueueRef.current.length}, AudioContext state: ${audioCtxRef.current?.state}`);
          audioQueueRef.current.push(buf);
          playNextChunk();
        } else {
          // JSON control message
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'joined') {
              setStatus('playing');
            } else if (msg.type === 'session_ended') {
              setStatus('ended');
              setErrorMsg('The session has ended.');
            } else if (msg.type === 'error') {
              setStatus('error');
              setErrorMsg(msg.message || 'Connection error');
            } else if (msg.type === 'warning') {
              // Could show a toast but keeping UI minimal
              console.log('Warning:', msg.message);
            }
          } catch {
            // ignore
          }
        }
      };

      ws.onerror = () => {
        console.error('WS error');
      };

      ws.onclose = (event) => {
        if (event.code === 1000 || status === 'ended') return; // normal close

        // Auto-reconnect with exponential backoff
        if (reconnectCountRef.current < MAX_RECONNECT_ATTEMPTS) {
          const delay = Math.pow(2, reconnectCountRef.current) * 1000;
          reconnectCountRef.current++;
          setReconnectCount(reconnectCountRef.current);
          console.log(`Reconnecting in ${delay}ms (attempt ${reconnectCountRef.current})`);
          reconnectTimerRef.current = setTimeout(() => {
            connectWS(selectedLang);
          }, delay);
        } else {
          setStatus('error');
          setErrorMsg('Lost connection to server. Please reload the page.');
        }
      };
    },
    [WS_URL, sessionId, playNextChunk, status]
  );

  const handleLanguageSelect = useCallback(
    (selectedLang: Lang) => {
      setLang(selectedLang);
      setStatus('waiting');

      // Initialize AudioContext (requires user gesture — this click counts)
      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContext();
      } else if (audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume();
      }

      connectWS(selectedLang);
    },
    [connectWS]
  );

  useEffect(() => {
    return () => {
      wsRef.current?.close();
      audioCtxRef.current?.close();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  }, []);

  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center px-4 max-w-sm mx-auto">
      {/* Header */}
      <h1 className="text-2xl font-bold mb-1 absolute top-8" style={{ color: '#1F3864' }}>
        LiveSpeak
      </h1>

      {/* Language selection */}
      {status === 'select_lang' && (
        <div className="w-full flex flex-col items-center gap-4">
          <p className="text-lg font-medium mb-4" style={{ color: '#1F3864' }}>
            Choose your language
          </p>
          {(['ta', 'fr', 'de'] as Lang[]).map((l) => (
            <button
              key={l}
              onClick={() => handleLanguageSelect(l)}
              className="w-full py-5 rounded-2xl text-white font-semibold text-xl active:opacity-80 transition-opacity"
              style={{ backgroundColor: '#2E75B6' }}
            >
              {LANG_LABELS[l]}
            </button>
          ))}
        </div>
      )}

      {/* Waiting for session to start */}
      {status === 'waiting' && (
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="w-12 h-12 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
          <p className="text-lg" style={{ color: '#1F3864' }}>
            Waiting for speaker...
          </p>
          <p className="text-sm opacity-60" style={{ color: '#1F3864' }}>
            {lang ? LANG_LABELS[lang] : ''} • Session {sessionId}
          </p>
        </div>
      )}

      {/* Playing */}
      {status === 'playing' && (
        <div className="flex flex-col items-center gap-6 text-center">
          {/* Audio wave animation */}
          <div className="flex items-end gap-1 h-12">
            {[1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className="w-2 rounded-full animate-pulse"
                style={{
                  backgroundColor: '#2E75B6',
                  height: `${20 + i * 8}px`,
                  animationDelay: `${i * 0.15}s`,
                  animationDuration: '1s',
                }}
              />
            ))}
          </div>

          <div>
            <p className="text-xl font-semibold" style={{ color: '#1F3864' }}>
              {lang ? LANG_LABELS[lang] : ''}
            </p>
            <p className="text-sm mt-1 opacity-60" style={{ color: '#1F3864' }}>
              Translation active
            </p>
          </div>

          {reconnectCount > 0 && (
            <p className="text-xs text-orange-500">
              Reconnecting... (attempt {reconnectCount}/{MAX_RECONNECT_ATTEMPTS})
            </p>
          )}
        </div>
      )}

      {/* Session ended */}
      {status === 'ended' && (
        <div className="flex flex-col items-center gap-4 text-center">
          <p className="text-xl font-semibold" style={{ color: '#1F3864' }}>
            Session ended
          </p>
          <p className="text-sm opacity-60" style={{ color: '#1F3864' }}>
            Thank you for listening
          </p>
        </div>
      )}

      {/* Error */}
      {status === 'error' && (
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="w-full bg-red-50 border border-red-200 rounded-xl p-5">
            <p className="text-red-700 font-medium">{errorMsg}</p>
          </div>
          <button
            onClick={() => {
              setStatus('select_lang');
              setErrorMsg('');
              setReconnectCount(0);
              reconnectCountRef.current = 0;
            }}
            className="w-full py-4 rounded-xl text-white font-semibold"
            style={{ backgroundColor: '#2E75B6' }}
          >
            Try Again
          </button>
        </div>
      )}
    </div>
  );
}
