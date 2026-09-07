// server.js — Synq (CommonJS, Express) — YouTube-powered music player, now
// with per-friend accounts.
//
// No local audio files: search, browse, and play come from YouTube's Data
// API + IFrame Player. This file proxies search/lookup calls (keeping the
// API key server-side), manages playlists + a small metadata cache, handles
// sign-up/login sessions, and keeps each account's playlists and recently-
// played separate so every friend gets their own library and their own
// "suggested for you" row.
//
// Deliberately CommonJS: this project can end up inside a cloud-synced
// folder (OneDrive/Dropbox/etc.), and Node's ESM resolver does far more
// filesystem round-trips per `import` than `require()` does, which gets
// very slow on those mounts.
//
// Storage: locally (`npm start`) this reads/writes a single db.local.json
// file straight off disk. Deployed on Vercel, functions have no writable
// persistent disk, so if an Upstash Redis integration is configured
// (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN env vars — added
// automatically by the Vercel Marketplace integration), the exact same data
// is kept there instead. Every call site awaits these, so the switch is
// invisible to the route handlers below. Accounts genuinely need this to be
// Redis in production — local-file storage on Vercel doesn't survive
// between deploys (or even between cold starts), so friends would get
// logged out / lose playlists constantly without it.

try { process.loadEnvFile(); } catch { /* no .env yet — that's fine, /api/search will explain */ }

const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const os = require("os");
const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.YOUTUBE_API_KEY || "";
const JWT_SECRET = process.env.JWT_SECRET || "";
const COOKIE_NAME = "synq_session";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DB_PATH = path.join(ROOT, "db.local.json");

// ---------- Redis (optional — only used when configured) ----------
// Different ways of connecting an Upstash database on Vercel land under
// different env var names: the newer "Upstash for Redis" native integration
// uses UPSTASH_REDIS_REST_URL/TOKEN, while databases connected through (or
// migrated from) the old Vercel KV integration use KV_REST_API_URL/TOKEN
// instead. Check both so either naming works.
let redis = null;
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
if (REDIS_URL && REDIS_TOKEN) {
  try {
    const { Redis } = require("@upstash/redis");
    redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
  } catch {
    console.warn("Redis env vars are set but the @upstash/redis package isn't installed — run `npm install`. Falling back to local file storage for now.");
  }
}

// ---------- Generic key/value storage (redis, or one local JSON file) ----------
function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}
function saveJson(file, data) {
  // Best-effort: on Vercel without the Redis integration connected yet, the
  // filesystem is read-only and this throws (EROFS). Search/playback still
  // work fine without it — only accounts/playlists/cache persistence is
  // affected — so this shouldn't take down the whole request.
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn(`Couldn't persist ${path.basename(file)} (${e.code || e.message}) — add the Upstash Redis integration on Vercel for real persistence.`);
  }
}
function loadLocalDb() { return loadJson(DB_PATH, {}); }
function saveLocalDb(db) { saveJson(DB_PATH, db); }

async function dbGet(key, fallback) {
  if (redis) {
    const v = await redis.get(key);
    return v == null ? fallback : v;
  }
  const db = loadLocalDb();
  return key in db ? db[key] : fallback;
}
async function dbSet(key, value) {
  if (redis) return void (await redis.set(key, value));
  const db = loadLocalDb();
  db[key] = value;
  saveLocalDb(db);
}

// ---------- Users ----------
async function loadUsers() { return dbGet("synq:users", {}); } // { [email]: user }
async function saveUsers(users) { return dbSet("synq:users", users); }

// ---------- Per-user playlists ----------
async function loadPlaylists(uid) { return dbGet(`synq:playlists:${uid}`, { playlists: [] }); }
async function savePlaylists(uid, data) { return dbSet(`synq:playlists:${uid}`, data); }

// ---------- Per-user recently played ----------
async function loadRecent(uid) { return dbGet(`synq:recent:${uid}`, []); }
async function saveRecent(uid, list) { return dbSet(`synq:recent:${uid}`, list); }

// ---------- Shared video metadata cache (not user-specific) ----------
async function loadCache() { return dbGet("synq:cache", {}); }
async function upsertCache(tracks) {
  const cache = await loadCache();
  for (const t of tracks) cache[t.id] = t;
  await dbSet("synq:cache", cache);
}

function newId() {
  return "pl_" + Math.random().toString(36).slice(2, 10);
}

// ---------- Demo account ----------
// Seeded automatically (idempotent — safe to run on every cold start) so
// anyone (recruiters included) can explore Synq without signing up. The
// credentials are intentionally not secret — they're shown right on the
// login screen — so this account should never be used for anything real.
const DEMO_EMAIL = "demo@synq.app";
const DEMO_PASSWORD = "SynqDemo123";
const DEMO_STARTER_TRACKS = [
  { id: "dQw4w9WgXcQ", title: "Never Gonna Give You Up", artist: "Rick Astley" },
  { id: "fJ9rUzIMcZQ", title: "Bohemian Rhapsody", artist: "Queen" },
  { id: "JGwWNGJdvx8", title: "Shape of You", artist: "Ed Sheeran" },
];
let demoSeedPromise = null;
async function ensureDemoUser() {
  const users = await loadUsers();
  let user = users[DEMO_EMAIL];
  if (!user) {
    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
    user = { id: "demo-user", name: "Demo", email: DEMO_EMAIL, passwordHash, createdAt: Date.now(), isDemo: true };
    users[DEMO_EMAIL] = user;
    await saveUsers(users);
  }
  const data = await loadPlaylists(user.id);
  if (!data.playlists.length) {
    await upsertCache(DEMO_STARTER_TRACKS);
    data.playlists.push({ id: newId(), name: "Demo Favorites", tracks: DEMO_STARTER_TRACKS.map((t) => t.id) });
    await savePlaylists(user.id, data);
  }
}
function ensureDemoUserOnce() {
  if (!demoSeedPromise) {
    demoSeedPromise = ensureDemoUser().catch((e) => {
      console.warn("Couldn't seed demo account:", e.message);
      demoSeedPromise = null; // let the next request try again
    });
  }
  return demoSeedPromise;
}

// ---------- Auth helpers ----------
function getJwtSecret() {
  if (!JWT_SECRET) {
    const err = new Error("Server isn't configured for accounts yet — add a JWT_SECRET (any long random string) to the environment and redeploy/restart.");
    err.status = 500;
    throw err;
  }
  return JWT_SECRET;
}
function issueSession(res, user) {
  const token = jwt.sign({ uid: user.id, name: user.name, email: user.email }, getJwtSecret(), { expiresIn: "30d" });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: !!process.env.VERCEL, // https in production, plain http is fine for local dev
    sameSite: "lax",
    maxAge: SESSION_MS,
    path: "/",
  });
}
function getUserFromReq(req) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token || !JWT_SECRET) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}
function authMiddleware(req, res, next) {
  const user = getUserFromReq(req);
  if (!user) return res.status(401).json({ error: "Please log in." });
  req.user = user; // { uid, name, email }
  next();
}

// ---------- Middleware ----------
app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(express.static(PUBLIC_DIR));
app.use((req, _res, next) => {
  console.log(new Date().toISOString(), req.method, req.url);
  next();
});

// ---------- Auth routes ----------
app.get("/api/auth/me", (req, res) => {
  const user = getUserFromReq(req);
  res.json({ user: user ? { id: user.uid, name: user.name, email: user.email } : null });
});

app.post("/api/auth/signup", async (req, res) => {
  try {
    getJwtSecret(); // fail fast with a clear message if accounts aren't configured
    await ensureDemoUserOnce(); // make sure demo@synq.app is reserved before anyone else can claim it
    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!name) return res.status(400).json({ error: "Name is required" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address" });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

    const users = await loadUsers();
    if (users[email]) return res.status(409).json({ error: "An account with that email already exists" });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = { id: crypto.randomUUID(), name, email, passwordHash, createdAt: Date.now() };
    users[email] = user;
    await saveUsers(users);

    issueSession(res, user);
    res.status(201).json({ user: { id: user.id, name: user.name, email: user.email } });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || "Sign up failed" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    getJwtSecret();
    await ensureDemoUserOnce();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const users = await loadUsers();
    const user = users[email];
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: "Incorrect email or password" });
    }
    issueSession(res, user);
    res.json({ user: { id: user.id, name: user.name, email: user.email } });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || "Log in failed" });
  }
});

app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

// ---------- YouTube helpers ----------
function parseISODuration(iso) {
  // e.g. "PT4M13S" -> 253 (seconds)
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || "");
  if (!m) return null;
  const h = parseInt(m[1] || "0", 10);
  const mi = parseInt(m[2] || "0", 10);
  const s = parseInt(m[3] || "0", 10);
  return h * 3600 + mi * 60 + s;
}

function extractVideoId(input) {
  const s = String(input || "").trim();
  if (/^[\w-]{11}$/.test(s)) return s; // already a bare video id
  try {
    const u = new URL(s);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1);
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const m = u.pathname.match(/\/embed\/([\w-]{11})/);
    if (m) return m[1];
  } catch { /* not a URL */ }
  return null;
}

function extractPlaylistId(input) {
  const s = String(input || "").trim();
  if (/^[\w-]{13,}$/.test(s) && !s.includes(".")) return s;
  try {
    const u = new URL(s);
    return u.searchParams.get("list");
  } catch {
    return null;
  }
}

async function ytFetch(endpoint, params) {
  if (!API_KEY) {
    const err = new Error("No YouTube API key configured. Add YOUTUBE_API_KEY to a .env file in the project root and restart the server.");
    err.status = 400;
    throw err;
  }
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  url.searchParams.set("key", API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || `YouTube API error (${res.status})`;
    const err = new Error(msg);
    err.status = res.status === 403 ? 403 : 502;
    throw err;
  }
  return data;
}

// Given raw video items from either search.list or videos.list, normalize + fetch durations.
async function normalizeVideos(items) {
  const ids = items.map((it) => (it.id?.videoId || it.id)).filter(Boolean);
  if (!ids.length) return [];

  const details = await ytFetch("videos", {
    part: "contentDetails,snippet",
    id: ids.join(","),
  });

  return details.items.map((v) => ({
    id: v.id,
    title: v.snippet.title,
    artist: v.snippet.channelTitle,
    thumbnail: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url || null,
    duration: parseISODuration(v.contentDetails.duration),
  }));
}

// ---------- Search / lookup (require login — keeps the API quota within your friend group) ----------
app.get("/api/search", authMiddleware, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "q required" });

    const search = await ytFetch("search", {
      part: "snippet",
      q,
      type: "video",
      videoCategoryId: "10", // Music
      maxResults: "20",
    });

    const tracks = await normalizeVideos(search.items || []);
    await upsertCache(tracks);
    res.json({ tracks });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || "Search failed" });
  }
});

app.get("/api/track/:id", authMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    const cache = await loadCache();
    if (cache[id]) return res.json({ track: cache[id] });

    const tracks = await normalizeVideos([{ id }]);
    if (!tracks.length) return res.status(404).json({ error: "Video not found" });
    await upsertCache(tracks);
    res.json({ track: tracks[0] });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || "Lookup failed" });
  }
});

// Resolve a pasted link/id/search term into a track (used by "paste a link" box)
app.post("/api/resolve", authMiddleware, async (req, res) => {
  try {
    const input = String(req.body?.input || "").trim();
    const videoId = extractVideoId(input);
    if (videoId) {
      const cache = await loadCache();
      if (cache[videoId]) return res.json({ track: cache[videoId] });
      const tracks = await normalizeVideos([{ id: videoId }]);
      if (!tracks.length) return res.status(404).json({ error: "Video not found" });
      await upsertCache(tracks);
      return res.json({ track: tracks[0] });
    }
    return res.status(400).json({ error: "Not a recognizable YouTube link/id" });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || "Resolve failed" });
  }
});

// Import an entire YouTube playlist into a new Synq playlist (for the logged-in user)
app.post("/api/import-playlist", authMiddleware, async (req, res) => {
  try {
    const input = String(req.body?.url || "").trim();
    const playlistId = extractPlaylistId(input);
    if (!playlistId) return res.status(400).json({ error: "Couldn't find a playlist id in that link" });

    let items = [];
    let pageToken = "";
    for (let page = 0; page < 10; page++) { // cap at ~500 items
      const data = await ytFetch("playlistItems", {
        part: "snippet",
        playlistId,
        maxResults: "50",
        ...(pageToken ? { pageToken } : {}),
      });
      items = items.concat(data.items || []);
      pageToken = data.nextPageToken || "";
      if (!pageToken) break;
    }

    const videoIds = items
      .map((it) => it.snippet?.resourceId?.videoId)
      .filter(Boolean);

    const tracks = [];
    for (let i = 0; i < videoIds.length; i += 50) {
      const batchIds = videoIds.slice(i, i + 50);
      // eslint-disable-next-line no-await-in-loop
      const batch = await normalizeVideos(batchIds.map((id) => ({ id })));
      tracks.push(...batch);
    }
    await upsertCache(tracks);

    const data = await loadPlaylists(req.user.uid);
    const p = { id: newId(), name: `Imported playlist (${tracks.length})`, tracks: tracks.map((t) => t.id) };
    data.playlists.push(p);
    await savePlaylists(req.user.uid, data);

    res.status(201).json(p);
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || "Import failed" });
  }
});

// ---------- Playlist APIs (per logged-in user) ----------
app.get("/api/playlists", authMiddleware, async (req, res) => {
  try {
    const data = await loadPlaylists(req.user.uid);
    res.json({ playlists: data.playlists.map((p) => ({ id: p.id, name: p.name, count: p.tracks.length })) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load playlists" });
  }
});

app.post("/api/playlists", authMiddleware, async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Name required" });
    const data = await loadPlaylists(req.user.uid);
    const p = { id: newId(), name, tracks: [] };
    data.playlists.push(p);
    await savePlaylists(req.user.uid, data);
    res.status(201).json(p);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create playlist" });
  }
});

app.put("/api/playlists/:pid", authMiddleware, async (req, res) => {
  try {
    const data = await loadPlaylists(req.user.uid);
    const p = data.playlists.find((x) => x.id === req.params.pid);
    if (!p) return res.status(404).json({ error: "Not found" });
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Name required" });
    p.name = name;
    await savePlaylists(req.user.uid, data);
    res.json(p);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to rename playlist" });
  }
});

app.delete("/api/playlists/:pid", authMiddleware, async (req, res) => {
  try {
    const data = await loadPlaylists(req.user.uid);
    const i = data.playlists.findIndex((x) => x.id === req.params.pid);
    if (i === -1) return res.status(404).json({ error: "Not found" });
    const removed = data.playlists.splice(i, 1)[0];
    await savePlaylists(req.user.uid, data);
    res.json(removed);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to delete playlist" });
  }
});

app.post("/api/playlists/:pid/tracks", authMiddleware, async (req, res) => {
  try {
    const trackId = String(req.body?.trackId || "");
    if (!trackId) return res.status(400).json({ error: "trackId required" });

    // Make sure we have metadata cached for it (so it can render later).
    const cache = await loadCache();
    if (!cache[trackId] && req.body?.meta) await upsertCache([{ id: trackId, ...req.body.meta }]);

    const data = await loadPlaylists(req.user.uid);
    const p = data.playlists.find((x) => x.id === req.params.pid);
    if (!p) return res.status(404).json({ error: "Playlist not found" });
    if (!p.tracks.includes(trackId)) p.tracks.push(trackId);
    await savePlaylists(req.user.uid, data);
    res.json({ ok: true, tracks: p.tracks });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to add track" });
  }
});

app.delete("/api/playlists/:pid/tracks", authMiddleware, async (req, res) => {
  try {
    const trackId = String(req.body?.trackId || "");
    const data = await loadPlaylists(req.user.uid);
    const p = data.playlists.find((x) => x.id === req.params.pid);
    if (!p) return res.status(404).json({ error: "Playlist not found" });
    p.tracks = p.tracks.filter((id) => id !== trackId);
    await savePlaylists(req.user.uid, data);
    res.json({ ok: true, tracks: p.tracks });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to remove track" });
  }
});

app.put("/api/playlists/:pid/order", authMiddleware, async (req, res) => {
  try {
    const order = Array.isArray(req.body?.trackIds) ? req.body.trackIds : null;
    if (!order) return res.status(400).json({ error: "trackIds array required" });
    const data = await loadPlaylists(req.user.uid);
    const p = data.playlists.find((x) => x.id === req.params.pid);
    if (!p) return res.status(404).json({ error: "Playlist not found" });
    const existing = new Set(p.tracks);
    const reordered = order.filter((id) => existing.has(id));
    for (const id of p.tracks) if (!reordered.includes(id)) reordered.push(id);
    p.tracks = reordered;
    await savePlaylists(req.user.uid, data);
    res.json({ ok: true, tracks: p.tracks });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to reorder playlist" });
  }
});

app.get("/api/playlists/:pid/tracks", authMiddleware, async (req, res) => {
  try {
    const data = await loadPlaylists(req.user.uid);
    const p = data.playlists.find((x) => x.id === req.params.pid);
    if (!p) return res.status(404).json({ error: "Playlist not found" });

    const cache = await loadCache();
    const missing = p.tracks.filter((id) => !cache[id]);
    if (missing.length) {
      const fetched = await normalizeVideos(missing.map((id) => ({ id })));
      await upsertCache(fetched);
    }
    const freshCache = missing.length ? await loadCache() : cache;
    const items = p.tracks.map((id) => freshCache[id]).filter(Boolean);
    res.json({ id: p.id, name: p.name, tracks: items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to read playlist" });
  }
});

// ---------- Recently played (per logged-in user) ----------
app.get("/api/recent", authMiddleware, async (req, res) => {
  try {
    res.json({ tracks: await loadRecent(req.user.uid) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load recently played" });
  }
});

app.post("/api/recent", authMiddleware, async (req, res) => {
  try {
    const t = req.body?.track;
    if (!t || !t.id) return res.status(400).json({ error: "track required" });
    let list = await loadRecent(req.user.uid);
    list = list.filter((x) => x.id !== t.id);
    list.unshift({ id: t.id, title: t.title, artist: t.artist, thumbnail: t.thumbnail, duration: t.duration });
    list = list.slice(0, 40);
    await saveRecent(req.user.uid, list);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to save recently played" });
  }
});

app.delete("/api/recent", authMiddleware, async (req, res) => {
  try {
    await saveRecent(req.user.uid, []);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to clear recently played" });
  }
});

// ---------- Suggestions ("suggested for you", based on recently played artists) ----------
app.get("/api/recommendations", authMiddleware, async (req, res) => {
  try {
    const recent = await loadRecent(req.user.uid);
    if (!recent.length) return res.json({ tracks: [] });

    const artists = [...new Set(recent.map((t) => t.artist).filter(Boolean))].slice(0, 2);
    const excludeIds = new Set(recent.map((t) => t.id));
    const seen = new Set();
    const tracks = [];

    for (const artist of artists) {
      const search = await ytFetch("search", {
        part: "snippet",
        q: artist,
        type: "video",
        videoCategoryId: "10",
        maxResults: "10",
      });
      const found = await normalizeVideos(search.items || []);
      await upsertCache(found);
      for (const t of found) {
        if (excludeIds.has(t.id) || seen.has(t.id)) continue;
        seen.add(t.id);
        tracks.push(t);
        if (tracks.length >= 12) break;
      }
      if (tracks.length >= 12) break;
    }
    res.json({ tracks });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || "Couldn't load suggestions" });
  }
});

// ---------- Debug ----------
app.get("/api/ping", (_req, res) => res.json({
  ok: true,
  ts: Date.now(),
  hasApiKey: !!API_KEY,
  hasAccounts: !!JWT_SECRET,
  storage: redis ? "redis" : "file",
}));

// ---------- SPA fallback ----------
app.use((_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

// ---------- Error handler ----------
app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || "Server error" });
});

function lanAddresses() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const iface of Object.values(nets)) {
    for (const addr of iface || []) {
      if (addr.family === "IPv4" && !addr.internal) out.push(addr.address);
    }
  }
  return out;
}

// Vercel imports this file as a module (module.exports = app) and never
// calls listen() itself — it runs the Express app as a single serverless
// function. Locally, `node server.js` / `npm start` still binds a real port
// the way it always has. Binding with no host below makes Express listen on
// 0.0.0.0 — every network interface, not just loopback — so it's already
// reachable from a phone on the same Wi-Fi (though see the README/.env.example
// note about YouTube's embed player needing a secure (https) origin — a
// plain http LAN IP won't actually play videos, only a tunnel or a real
// deployment will).
if (require.main === module) {
  if (JWT_SECRET) ensureDemoUserOnce();
  app.listen(PORT, () => {
    console.log(`Synq running on http://localhost:${PORT}`);
    const ips = lanAddresses();
    if (ips.length) {
      console.log("On your phone (same Wi-Fi), open:");
      ips.forEach((ip) => console.log(`  http://${ip}:${PORT}`));
      console.log("(Note: YouTube playback needs a secure/https origin, so the plain http LAN address above will load the app but won't play videos — use a tunnel or the deployed Vercel URL for that.)");
    } else {
      console.log("Couldn't detect a LAN IP — check `ipconfig` for your Wi-Fi adapter's IPv4 address.");
    }
    console.log(API_KEY ? "YouTube API key loaded." : "No YOUTUBE_API_KEY set — search will not work until you add one to .env");
    console.log(JWT_SECRET ? "Accounts enabled (JWT_SECRET set)." : "No JWT_SECRET set — sign up/login will fail until you add one to .env");
    console.log(redis ? "Using Upstash Redis for storage." : "Using a local db.local.json file for storage.");
  });
}

module.exports = app;
