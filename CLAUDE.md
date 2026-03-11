# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install

# Start the server
npm start
# or
node index.js
```

There are no tests configured (`npm test` exits with an error by default).

## Environment Setup

Copy `.env.example` to `.env` and fill in values before running:

- `PUBLIC_BASE_URL` — publicly accessible URL (e.g. ngrok/cloudflared tunnel) used to construct Twilio callback URLs
- `TWILIO_AUTH_TOKEN` — enables Twilio webhook signature validation; omit to skip validation
- `PORT` — defaults to `8080`
- Optional: `TWILIO_TRANSCRIPTION_TRACK`, `TWILIO_TRANSCRIPTION_LANGUAGE`, `TWILIO_TRANSCRIPTION_ENGINE`, `TWILIO_TRANSCRIPTION_MODEL`

## Architecture

This is a single-file Node.js/Express backend (`index.js`) with a static frontend in `public/`.

### Backend (`index.js`)

All call state is held **in-memory** — there is no database. The server restarts with a clean slate.

**Core data structures:**
- `calls` — `Map<callId, callObject>` storing all active/completed calls
- `sseClients` — `Set` of active SSE response objects for push broadcasting
- `twilioSeqByCall` — deduplication map for Twilio transcription sequence IDs

**Data flow:**
1. A call arrives via `POST /twilio/voice` (Twilio webhook) or is created lazily on first reference. The server responds with TwiML that starts live transcription.
2. Twilio posts incremental transcription events to `POST /twilio/transcription`, which appends transcript entries and broadcasts over SSE.
3. An external AI agent (ElevenLabs or similar) posts enriched data to the three webhook endpoints below.
4. The frontend connects to `GET /events` (SSE) and receives `call_update` events for every change.

**Webhook endpoints (for external AI/automation nodes):**
- `POST /webhook/transcript` — replaces or appends transcript, updates caller metadata
- `POST /webhook/location` — accepts a text location string (geocoded via Nominatim/OpenStreetMap) or explicit `lat`/`lng` coordinates
- `POST /webhook/summary` — updates the call summary text

**Other endpoints:**
- `GET /v1/ausgrid/planned` — proxies and normalizes Ausgrid planned outage data; supports `?days=` and `?limit=` query params
- `GET /api/calls` / `GET /api/calls/:callId` — read call state
- `GET /events` — SSE stream

All Twilio-facing routes run through `verifyTwilioRequest` middleware, which validates the `X-Twilio-Signature` header when `TWILIO_AUTH_TOKEN` is set.

### Frontend (`public/`)

- `index.html` / `landing.css` — marketing landing page
- `dashboard.html` / `dashboard.css` / `dashboard.js` — the live ops dashboard

The dashboard connects to `GET /events` via `EventSource`, loads initial state from `GET /api/calls`, and renders:
- Caller metadata, status, issue, severity, summary
- Live transcript as chat bubbles (caller vs. agent)
- Leaflet.js map with geocoded caller location pin
- Metrics panel (call count, duration estimates, city breakdown)
- Multi-call list sidebar (select any call by clicking)

The dashboard uses Leaflet with CartoDB tiles (loaded from CDN in `dashboard.html`) and has a drag-to-resize transcript panel.