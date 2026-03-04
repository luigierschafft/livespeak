import { config } from 'dotenv';
config({ path: '.env.local' });
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { processChunk } from './lib/audioPipeline';
import * as crypto from 'crypto';
import * as url from 'url';

const PORT = parseInt(process.env.PORT || '8080', 10);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:3000';
const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const WARNING_BEFORE_END_MS = 60 * 1000;   // warn 1 min before end
const MAX_LISTENERS_PER_SESSION = 10;

type Lang = 'ta' | 'fr' | 'de';

const CONTEXT_MAX_CHUNKS = 6; // ~30s of rolling context

interface Session {
  id: string;
  broadcasterSocket: WebSocket;
  listenerSockets: Map<Lang, Set<WebSocket>>;
  status: 'active' | 'ended';
  createdAt: Date;
  timeoutAt: Date;
  timeoutTimer: NodeJS.Timeout;
  warningTimer: NodeJS.Timeout;
  transcriptionHistory: string[];
}

const sessions = new Map<string, Session>();

function generateSessionId(): string {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function totalListeners(session: Session): number {
  let count = 0;
  for (const s of session.listenerSockets.values()) count += s.size;
  return count;
}

function sendJSON(ws: WebSocket, data: object) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcastToListeners(session: Session, lang: Lang, audioBuf: Buffer) {
  const sockets = session.listenerSockets.get(lang);
  if (!sockets) return;
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(audioBuf);
    }
  }
}

function endSession(session: Session, reason: string) {
  if (session.status === 'ended') return;
  session.status = 'ended';
  clearTimeout(session.timeoutTimer);
  clearTimeout(session.warningTimer);

  // Notify all listeners
  for (const sockets of session.listenerSockets.values()) {
    for (const ws of sockets) {
      sendJSON(ws, { type: 'session_ended', reason });
      ws.close();
    }
  }

  // Notify broadcaster
  if (session.broadcasterSocket.readyState === WebSocket.OPEN) {
    sendJSON(session.broadcasterSocket, { type: 'session_ended', reason });
    session.broadcasterSocket.close();
  }

  sessions.delete(session.id);
  console.log(`Session ${session.id} ended: ${reason}`);
}

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const origin = req.headers.origin || '';
  if (origin && origin !== ALLOWED_ORIGIN && !ALLOWED_ORIGIN.includes('localhost')) {
    console.warn(`Rejected connection from origin: ${origin}`);
    ws.close(1008, 'Forbidden');
    return;
  }

  const parsedUrl = url.parse(req.url || '', true);
  const pathname = parsedUrl.pathname || '';

  // ── Broadcaster ──────────────────────────────────────────
  if (pathname === '/broadcast') {
    const sessionId = generateSessionId();
    const now = new Date();
    const timeoutAt = new Date(now.getTime() + SESSION_TIMEOUT_MS);

    const warningTimer = setTimeout(() => {
      if (session.status === 'active') {
        sendJSON(ws, { type: 'warning', message: '1 minute remaining' });
        for (const sockets of session.listenerSockets.values()) {
          for (const lws of sockets) {
            sendJSON(lws, { type: 'warning', message: '1 minute remaining' });
          }
        }
      }
    }, SESSION_TIMEOUT_MS - WARNING_BEFORE_END_MS);

    const timeoutTimer = setTimeout(() => {
      endSession(session, 'timeout');
    }, SESSION_TIMEOUT_MS);

    const session: Session = {
      id: sessionId,
      broadcasterSocket: ws,
      listenerSockets: new Map([
        ['ta', new Set()],
        ['fr', new Set()],
        ['de', new Set()],
      ]),
      status: 'active',
      createdAt: now,
      timeoutAt,
      timeoutTimer,
      warningTimer,
      transcriptionHistory: [],
    };

    sessions.set(sessionId, session);
    console.log(`Session created: ${sessionId}`);

    sendJSON(ws, {
      type: 'session_created',
      sessionId,
      timeoutAt: timeoutAt.toISOString(),
    });

    ws.on('message', async (data: Buffer, isBinary: boolean) => {
      if (session.status !== 'active') return;

      if (isBinary) {
        // Audio chunk from broadcaster
        console.log(`[1] Binary chunk received — ${data.length} bytes, listeners: ta=${session.listenerSockets.get('ta')?.size ?? 0} fr=${session.listenerSockets.get('fr')?.size ?? 0}`);
        try {
          const { audioMap, transcribedText } = await processChunk(data, ['ta', 'fr', 'de'], session.transcriptionHistory);

          // Update rolling context history
          if (transcribedText) {
            session.transcriptionHistory.push(transcribedText);
            if (session.transcriptionHistory.length > CONTEXT_MAX_CHUNKS) {
              session.transcriptionHistory.shift();
            }
          }

          console.log(`[5] processChunk returned langs: [${[...audioMap.keys()].join(', ') || 'none'}]`);
          for (const [lang, audioBuf] of audioMap) {
            const count = session.listenerSockets.get(lang as Lang)?.size ?? 0;
            console.log(`[6] Sending ${audioBuf.length} bytes to ${count} listener(s) for lang=${lang}`);
            broadcastToListeners(session, lang as Lang, audioBuf);
          }
        } catch (err) {
          console.error(`processChunk error in session ${sessionId}:`, err);
          // Skip this chunk, continue
        }
      } else {
        // Text control message
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'stop') {
            endSession(session, 'broadcaster_stopped');
          }
        } catch {
          // ignore malformed JSON
        }
      }
    });

    ws.on('close', () => {
      endSession(session, 'broadcaster_disconnected');
    });

    ws.on('error', (err) => {
      console.error(`Broadcaster WS error in session ${sessionId}:`, err);
      endSession(session, 'broadcaster_error');
    });

    return;
  }

  // ── Listener ─────────────────────────────────────────────
  if (pathname === '/listen') {
    const sessionId = (parsedUrl.query.sessionId as string) || '';
    const lang = (parsedUrl.query.lang as Lang) || '';

    if (!sessionId || !['ta', 'fr', 'de'].includes(lang)) {
      sendJSON(ws, { type: 'error', message: 'Missing or invalid sessionId/lang' });
      ws.close();
      return;
    }

    const session = sessions.get(sessionId);
    if (!session || session.status !== 'active') {
      sendJSON(ws, { type: 'error', message: 'Session not found or has ended' });
      ws.close();
      return;
    }

    if (totalListeners(session) >= MAX_LISTENERS_PER_SESSION) {
      sendJSON(ws, { type: 'error', message: 'Session is full (max 10 listeners)' });
      ws.close();
      return;
    }

    session.listenerSockets.get(lang)!.add(ws);
    console.log(`Listener joined session ${sessionId} (${lang})`);

    sendJSON(ws, {
      type: 'joined',
      sessionId,
      lang,
      timeoutAt: session.timeoutAt.toISOString(),
    });

    ws.on('close', () => {
      session.listenerSockets.get(lang)?.delete(ws);
    });

    ws.on('error', () => {
      session.listenerSockets.get(lang)?.delete(ws);
    });

    return;
  }

  // Unknown path
  ws.close(1008, 'Not found');
});

wss.on('listening', () => {
  console.log(`LiveSpeak WebSocket server running on ws://localhost:${PORT}`);
});

wss.on('error', (err) => {
  console.error('WSS error:', err);
});
