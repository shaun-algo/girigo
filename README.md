# 기리고 — Ritual Wish App

A mysterious cult-ritual app where users record video wishes and await the oracle's decree.

## Setup

```bash
npm install
cp .env.example .env
npm start
# Open http://localhost:3000
```

Without Supabase env vars, the app uses local fallback storage in `data/`.

## Supabase Setup

1. Create a Supabase project.
2. Create a private Storage bucket named `girigo-wishes`.
3. Run [supabase/schema.sql](supabase/schema.sql) in the Supabase SQL editor.
4. Set these env vars locally and in Vercel:

```bash
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_BUCKET=girigo-wishes
GIRIGO_ADMIN_CODE=your-private-code
GIRIGO_ADMIN_SESSION=your-long-random-session-secret
```

When Supabase is configured, videos upload directly from the browser to Supabase Storage through signed upload URLs, and wish metadata is stored in Supabase Postgres.

## Architecture

```text
girigo/
├── server/
│   └── index.js        ← Express oracle server
├── public/
│   └── index.html      ← Frontend (SPA)
│   └── girigo.mp3      ← optional ambient BGM
│   └── hands.png       ← optional hand asset
├── data/
│   ├── wishes.json     ← Persisted wish store (auto-created)
│   └── videos/         ← Uploaded wish videos (auto-created)
├── supabase/
│   └── schema.sql      ← Supabase wishes table
└── package.json
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/wish` | Submit a wish (multipart: `video`, `durationSec`) |
| `POST` | `/api/wish/upload-url` | Create a Supabase signed upload URL |
| `POST` | `/api/wish/complete` | Save metadata after direct Supabase upload |
| `GET` | `/api/wish/:id` | Check wish phase/status |
| `GET` | `/api/phases` | List all oracle phases |
