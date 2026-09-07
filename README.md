# 🎧 Synq

A YouTube-powered music player with real accounts — search, build playlists, and get simple recommendations, all backed by the YouTube Data API instead of local audio files. Built so a small group of friends can each have their own library on one shared app.

**Live demo:** [synq-sage-two.vercel.app](https://synq-sage-two.vercel.app)

Don't want to sign up? Click **"Try the demo account"** on the login screen, or log in manually with:

```
email:    demo@synq.app
password: SynqDemo123
```

## Why

Streaming services either cost money per listener or don't let you share your library with friends without everyone paying for their own premium plan. Synq is a lightweight alternative: search and play anything on YouTube, organize it into playlists, and every friend who signs up gets their own private library, recently-played history, and recommendations — on one app, for free.

## Features

- **Accounts** — email/password sign up and log in, passwords hashed with bcrypt, sessions kept in a signed, httpOnly JWT cookie. Every user gets their own playlists, recently-played history, and suggestions.
- **Search & import** — search YouTube directly (the API key never reaches the browser), or paste a video/playlist link to pull it straight into the app.
- **Playlists** — create, rename, delete, reorder by drag-and-drop, add/remove tracks.
- **Queue & full player** — play/pause, next/previous, shuffle, repeat, seek, volume, plus a slide-out queue.
- **Home view** — recently played, a "Suggested for you" row (based on the artists you've been listening to), your playlists, and genre shortcuts.
- **Recommendations** — a simple content-based suggestion engine: it looks at the artists in your recent listens and surfaces more from them.
- **Responsive design** — full desktop layout with a sidebar and persistent player bar; on mobile, a bottom nav, a full-screen library sheet, and a full-screen "Now Playing" sheet.
- **Demo account** — seeded automatically so anyone can explore the app without creating an account.

## Tech stack

| Layer | Choice |
|---|---|
| Backend | Node.js + Express 5 |
| Frontend | Vanilla JavaScript, HTML, CSS — no framework |
| Auth | bcryptjs (password hashing) + jsonwebtoken (session cookies) |
| Data source | YouTube Data API v3 |
| Storage | Upstash Redis in production, a local JSON file for local dev — same code path either way |
| Hosting | Vercel (Express app deployed as a serverless function) |

## Architecture notes

- The Express app is exported as-is (`module.exports = app`) so Vercel can run it as a serverless function; locally, `npm start` still binds a real port the normal way.
- All YouTube API calls happen server-side, so the API key is never exposed to the client and every user shares one quota.
- Storage is behind a tiny `dbGet`/`dbSet` abstraction: if `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` are set, everything (accounts, playlists, recently-played, the video metadata cache) is stored in Redis; otherwise it falls back to a local JSON file. This matters on Vercel specifically, since serverless functions have no writable persistent disk — without Redis, accounts wouldn't survive a redeploy.
- Sessions are stateless JWTs, so checking "am I logged in" never touches the database — only user *data* (playlists, recent tracks) requires a storage read.

## Getting started locally

1. **Clone and install**

   ```bash
   git clone https://github.com/Lucifer-0427/Synq.git
   cd Synq
   npm install
   ```

2. **Get a YouTube Data API key** (free) — [console.cloud.google.com](https://console.cloud.google.com/apis/library/youtube.googleapis.com), enable the YouTube Data API v3, then create an API key under Credentials. The free tier gives 10,000 quota units/day (~100 searches).

3. **Configure environment variables** — copy `.env.example` to `.env` and fill in:

   ```
   YOUTUBE_API_KEY=your-key-here
   JWT_SECRET=some-long-random-string
   ```

   Generate a `JWT_SECRET` with:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` are optional locally — without them, accounts and playlists are stored in a local `db.local.json` file, which works fine for `npm start`.

4. **Run it**

   ```bash
   npm start
   ```

   Open `http://localhost:3000`. Note: YouTube's embedded player requires a secure (https) origin, so playback works on `localhost` but not over a plain-http LAN address — use a tunnel or the deployed Vercel URL to test on another device.

## Deploying

Synq deploys to Vercel with zero config beyond environment variables:

1. Import the repo into Vercel.
2. Add `YOUTUBE_API_KEY` and `JWT_SECRET` under Project Settings → Environment Variables.
3. Add the **Upstash for Redis** integration from the Vercel Marketplace (Free plan is plenty) so accounts and playlists persist across deploys — connect it to the project and leave "Custom Prefix" blank.
4. Deploy.

## License

Personal project — no license file yet; feel free to poke around, but it's not currently packaged for reuse.
