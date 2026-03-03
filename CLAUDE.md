# LiveSpeak — Claude Code Instructions

## Project Overview
Real-time lecture translation app. Speaker talks into phone → Whisper STT → GPT-4o translation → OpenAI TTS → Listeners hear audio in their language.

## Tech Stack
- **Frontend/Backend**: Next.js 14 (App Router) + TypeScript + Tailwind CSS
- **Realtime**: WebSockets (`ws` library) — standalone server, NOT Next.js API routes
- **AI**: OpenAI SDK (`openai` npm) — Whisper, GPT-4o, TTS
- **QR Code**: `react-qr-code`
- **Deploy**: Vercel (frontend) + Fly.io or Railway (WebSocket server)

## Key Architecture Decisions
- WebSocket server runs standalone (`server.ts`) — Vercel serverless does NOT support persistent WebSocket connections
- Sessions are fully ephemeral (in-memory only, no database)
- Audio chunks: ~3 seconds (WebM/Opus from MediaRecorder)
- TTS + translation run in parallel per target language
- Max 10 concurrent listeners per session, 10-minute session limit

## MVP Languages
- Source: English (en) — fixed in MVP
- Targets: Tamil (ta), French (fr)

## Routes
- `/broadcast` — Speaker view
- `/listen/[sessionId]` — Listener view

## Environment Variables
```
OPENAI_API_KEY=sk-...
NEXT_PUBLIC_WS_URL=wss://...  # WebSocket server URL
```

## Important Rules
- NEVER expose `OPENAI_API_KEY` to the client — all OpenAI calls happen server-side
- Audio autoplay requires a prior user gesture — listener MUST tap Play first
- WebSocket server must set CORS to allow Vercel frontend domain
- No database, no auth, no persistent storage — keep it ephemeral

## Audio Pipeline (per chunk)
1. Broadcaster sends binary audio chunk via WebSocket (~3s WebM/Opus)
2. Server: Whisper STT → English text
3. Server: GPT-4o → Tamil text + French text (parallel)
4. Server: TTS Tamil + TTS French (parallel)
5. Push audio buffers to listener rooms via WebSocket

## Session State Interface
```ts
interface Session {
  id: string;
  broadcasterSocket: WebSocket;
  listenerSockets: Map<'ta' | 'fr', Set<WebSocket>>;
  status: 'active' | 'ended';
  createdAt: Date;
  timeoutAt: Date; // +10 minutes
  timeoutTimer: NodeJS.Timeout;
}
```

## UI Colors
- Background: white
- Primary text: `#1F3864` (dark navy)
- Buttons: `#2E75B6` (blue)
- Font: Inter or system-ui
- Mobile-first: 375px portrait

## Cost Reference (60-min lecture)
- Whisper: ~$0.36
- GPT-4o: ~$0.15
- TTS: ~$0.45
- **Total: ~$0.96**
