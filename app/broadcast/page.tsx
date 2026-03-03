'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import QRCode from 'react-qr-code';

type Status = 'idle' | 'connecting' | 'broadcasting' | 'ended' | 'error';

export default function BroadcastPage() {
  const [status, setStatus] = useState<Status>('idle');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [timeLeft, setTimeLeft] = useState<number>(600); // seconds
  const [copied, setCopied] = useState(false);
  const [warning, setWarning] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const timeoutAtRef = useRef<Date | null>(null);

  const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8080';

  const listenerUrl = sessionId
    ? `${window.location.origin}/listen/${sessionId}`
    : '';

  const startCountdown = useCallback((timeoutAt: Date) => {
    timeoutAtRef.current = timeoutAt;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      const now = new Date();
      const remaining = Math.max(
        0,
        Math.floor((timeoutAtRef.current!.getTime() - now.getTime()) / 1000)
      );
      setTimeLeft(remaining);
      if (remaining <= 60) setWarning(true);
      if (remaining === 0) {
        if (timerRef.current) clearInterval(timerRef.current);
      }
    }, 1000);
  }, []);

  const stopBroadcast = useCallback(() => {
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stop' }));
      wsRef.current.close();
    }
    if (timerRef.current) clearInterval(timerRef.current);
    setStatus('ended');
  }, []);

  const startBroadcast = useCallback(async () => {
    setStatus('connecting');
    setErrorMsg('');

    // Request microphone
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
    } catch {
      setStatus('error');
      setErrorMsg(
        'Microphone access denied. Please allow microphone access in your browser settings.'
      );
      return;
    }

    // Connect WebSocket
    const ws = new WebSocket(`${WS_URL}/broadcast`);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WS connected');
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'session_created') {
          setSessionId(msg.sessionId);
          setStatus('broadcasting');
          startCountdown(new Date(msg.timeoutAt));

          // Start recording
          const recorder = new MediaRecorder(stream, {
            mimeType: 'audio/webm;codecs=opus',
          });
          recorderRef.current = recorder;

          recorder.ondataavailable = (e) => {
            if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) {
              ws.send(e.data);
            }
          };

          recorder.start(3000); // 3-second chunks
        } else if (msg.type === 'session_ended') {
          stopBroadcast();
        } else if (msg.type === 'warning') {
          setWarning(true);
        }
      } catch {
        // ignore
      }
    };

    ws.onerror = () => {
      setStatus('error');
      setErrorMsg('Connection to server failed. Is the WebSocket server running?');
      stream.getTracks().forEach((t) => t.stop());
    };

    ws.onclose = () => {
      if (status === 'broadcasting') {
        setStatus('ended');
      }
    };
  }, [WS_URL, startCountdown, stopBroadcast, status]);

  const copyLink = useCallback(() => {
    if (!listenerUrl) return;
    navigator.clipboard.writeText(listenerUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [listenerUrl]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      wsRef.current?.close();
    };
  }, []);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  return (
    <div className="min-h-screen bg-white flex flex-col items-center px-4 py-8 max-w-sm mx-auto">
      {/* Header */}
      <h1 className="text-2xl font-bold mb-1" style={{ color: '#1F3864' }}>
        LiveSpeak
      </h1>
      <p className="text-sm mb-8" style={{ color: '#1F3864', opacity: 0.7 }}>
        Broadcast your lecture
      </p>

      {/* Idle / Error state */}
      {(status === 'idle' || status === 'error') && (
        <div className="w-full flex flex-col items-center gap-4">
          {status === 'error' && (
            <div className="w-full bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
              {errorMsg}
            </div>
          )}
          <button
            onClick={startBroadcast}
            className="w-full py-4 rounded-xl text-white font-semibold text-lg transition-opacity active:opacity-80"
            style={{ backgroundColor: '#2E75B6' }}
          >
            Start Broadcasting
          </button>
        </div>
      )}

      {/* Connecting */}
      {status === 'connecting' && (
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
          <p style={{ color: '#1F3864' }}>Connecting...</p>
        </div>
      )}

      {/* Broadcasting */}
      {status === 'broadcasting' && sessionId && (
        <div className="w-full flex flex-col items-center gap-6">
          {/* Live indicator */}
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 bg-red-500 rounded-full animate-pulse" />
            <span className="font-semibold text-red-600">LIVE</span>
          </div>

          {/* Timer */}
          <div
            className={`text-3xl font-mono font-bold ${warning ? 'text-red-600' : ''}`}
            style={warning ? {} : { color: '#1F3864' }}
          >
            {formatTime(timeLeft)}
          </div>
          {warning && (
            <p className="text-sm text-red-600 -mt-4">Less than 1 minute remaining</p>
          )}

          {/* QR Code */}
          <div className="p-4 bg-white border-2 rounded-xl" style={{ borderColor: '#2E75B6' }}>
            <QRCode value={listenerUrl} size={180} />
          </div>

          {/* Session ID */}
          <p className="text-xs" style={{ color: '#1F3864', opacity: 0.6 }}>
            Session: {sessionId}
          </p>

          {/* Copy link */}
          <button
            onClick={copyLink}
            className="w-full py-3 rounded-xl border-2 font-medium transition-colors"
            style={{ borderColor: '#2E75B6', color: '#2E75B6' }}
          >
            {copied ? 'Copied!' : 'Copy Listener Link'}
          </button>

          {/* Listener URL */}
          <p className="text-xs text-center break-all" style={{ color: '#1F3864', opacity: 0.5 }}>
            {listenerUrl}
          </p>

          {/* Stop */}
          <button
            onClick={stopBroadcast}
            className="w-full py-4 rounded-xl bg-red-600 text-white font-semibold text-lg active:opacity-80"
          >
            Stop Broadcasting
          </button>
        </div>
      )}

      {/* Ended */}
      {status === 'ended' && (
        <div className="flex flex-col items-center gap-4 text-center">
          <p className="text-lg font-semibold" style={{ color: '#1F3864' }}>
            Session ended
          </p>
          <button
            onClick={() => {
              setStatus('idle');
              setSessionId(null);
              setTimeLeft(600);
              setWarning(false);
            }}
            className="w-full py-4 rounded-xl text-white font-semibold text-lg"
            style={{ backgroundColor: '#2E75B6' }}
          >
            Start New Session
          </button>
        </div>
      )}
    </div>
  );
}
