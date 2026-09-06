// server.js — Synq (CommonJS, Express) — YouTube-powered music player
//
// No local audio files: search, browse, and play come from YouTube's Data
// API + IFrame Player. This file only ever proxies search/lookup calls
// (keeping the API key server-side) and manages playlists (which just
// store YouTube video ids) plus a small metadata cache so playlist/queue
// views don't need to re-hit the API for tracks you've already seen.
//
// Deliberately CommonJS: this project can end up inside a cloud-synced
// folder (OneDrive/Dropbox/etc.), and Node's ESM resolver does far more
// filesystem round-trips per `import` than `require()` does, which gets
// very slow on those mounts.
//
// Storage: locally (`npm start`) this reads/writes playlists.json and
// tracks-cache.json straight off disk. Deployed on Vercel, functions have
// no writable persistent disk, so if an Upstash Redis integration is
// configured (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN env vars —
// added automatically by the Vercel Marketplace integration), the exact
// same data is kept there instead. Every call site awaits these, so the
// switch is invisible to the route handlers below.

try { process.loadEnvFile(); } catch { /* no .env yet — that's fine, /api/search will explain */ }

const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const os = require("os");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.YOUTUBE_API_KEY || "";

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const PLAYLISTS_PATH = path.join(ROOT, "playlists.json");
const CACHE_PATH = path.join(ROOT, "tracks-cache.json");

// ---------- Redis (optional — only used when configured) ----------
let redis = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  try {
    const { Redis } = require("@upstash/redis");
    redis = Redis.fromEnv();
  } catch {
    console.warn("UPSTASH_REDIS_REST_URL is set but the @upstash/redis package isn't installed — run `npm install @upstash/redis`. Falling back to local file storage for now.");
  }
}

// ---------- Playlist + cache storage ----------
function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}
function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
async function loadPlaylists() {
  if (redis) return (await redis.get("synq:playlists")) || { playlists: [] };
  return loadJson(PLAYLISTS_PATH, { playlists: [] });
}
async function savePlaylists(data) {
  if (redis) return void (await redis.set("synq:playlists", data));
  saveJson(PLAYLISTS_PATH, data);
}
async function loadCache() {
  if (redis) return (await redis.get("synq:cache")) || {};
  return loadJson(CACHE_PATH, {});
}
async function upsertCache(tracks) {
  const cache = await loadCache();
  for (const t of tracks) cache[t.id] = t;
  if (redis) return void (await redis.set("synq:cache", cache));
  saveJson(CACHE_PATH, cache);
}
function newId() {
  return "pl_" + Math.random().toString(36).slice(2, 10);
}

// ---------- Middleware ----------
app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));
app.use((req, _res, next) => {
  console.log(new Date().toISOString(), req.method, req.url);
  next();
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

// ---------- Search / lookup ----------
app.get("/api/search", async (req, res) => {
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

app.get("/api/track/:id", async (req, res) => {
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
app.post("/api/resolve", async (req, res) => {
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

// Import an entire YouTube playlist into a new local Synq playlist
app.post("/api/import-playlist", async (req, res) => {
  try {
    const input = String(req.body?.url || "").trim();
    const playlistId = extractPlaylistId(input);
    if (!playlistId) return res.status(400).json({ error: "Couldn't find a playlist id in that link" });

    let items = [];
    let pageToken = "";
    let title = "Imported playlist";
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

    if (items[0]?.snippet?.title) title = "Imported: " + items[0].snippet.title.split(" - ")[0];

    const data = await loadPlaylists();
    const p = { id: newId(), name: `Imported playlist (${tracks.length})`, tracks: tracks.map((t) => t.id) };
    data.playlists.push(p);
    await savePlaylists(data);

    res.status(201).json(p);
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || "Import failed" });
  }
});

// ---------- Playlist APIs ----------
app.get("/api/playlists", async (_req, res) => {
  try {
    const data = await loadPlaylists();
    res.json({ playlists: data.playlists.map((p) => ({ id: p.id, name: p.name, count: p.tracks.length })) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load playlists" });
  }
});

app.post("/api/playlists", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Name required" });
    const data = await loadPlaylists();
    const p = { id: newId(), name, tracks: [] };
    data.playlists.push(p);
    await savePlaylists(data);
    res.status(201).json(p);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create playlist" });
  }
});

app.put("/api/playlists/:pid", async (req, res) => {
  try {
    const data = await loadPlaylists();
    const p = data.playlists.find((x) => x.id === req.params.pid);
    if (!p) return res.status(404).json({ error: "Not found" });
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Name required" });
    p.name = name;
    await savePlaylists(data);
    res.json(p);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to rename playlist" });
  }
});

app.delete("/api/playlists/:pid", async (req, res) => {
  try {
    const data = await loadPlaylists();
    const i = data.playlists.findIndex((x) => x.id === req.params.pid);
    if (i === -1) return res.status(404).json({ error: "Not found" });
    const removed = data.playlists.splice(i, 1)[0];
    await savePlaylists(data);
    res.json(removed);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to delete playlist" });
  }
});

app.post("/api/playlists/:pid/tracks", async (req, res) => {
  try {
    const trackId = String(req.body?.trackId || "");
    if (!trackId) return res.status(400).json({ error: "trackId required" });

    // Make sure we have metadata cached for it (so it can render later).
    const cache = await loadCache();
    if (!cache[trackId] && req.body?.meta) await upsertCache([{ id: trackId, ...req.body.meta }]);

    const data = await loadPlaylists();
    const p = data.playlists.find((x) => x.id === req.params.pid);
    if (!p) return res.status(404).json({ error: "Playlist not found" });
    if (!p.tracks.includes(trackId)) p.tracks.push(trackId);
    await savePlaylists(data);
    res.json({ ok: true, tracks: p.tracks });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to add track" });
  }
});

app.delete("/api/playlists/:pid/tracks", async (req, res) => {
  try {
    const trackId = String(req.body?.trackId || "");
    const data = await loadPlaylists();
    const p = data.playlists.find((x) => x.id === req.params.pid);
    if (!p) return res.status(404).json({ error: "Playlist not found" });
    p.tracks = p.tracks.filter((id) => id !== trackId);
    await savePlaylists(data);
    res.json({ ok: true, tracks: p.tracks });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to remove track" });
  }
});

app.put("/api/playlists/:pid/order", async (req, res) => {
  try {
    const order = Array.isArray(req.body?.trackIds) ? req.body.trackIds : null;
    if (!order) return res.status(400).json({ error: "trackIds array required" });
    const data = await loadPlaylists();
    const p = data.playlists.find((x) => x.id === req.params.pid);
    if (!p) return res.status(404).json({ error: "Playlist not found" });
    const existing = new Set(p.tracks);
    const reordered = order.filter((id) => existing.has(id));
    for (const id of p.tracks) if (!reordered.includes(id)) reordered.push(id);
    p.tracks = reordered;
    await savePlaylists(data);
    res.json({ ok: true, tracks: p.tracks });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to reorder playlist" });
  }
});

app.get("/api/playlists/:pid/tracks", async (req, res) => {
  try {
    const data = await loadPlaylists();
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

// ---------- Debug ----------
app.get("/api/ping", (_req, res) => res.json({ ok: true, ts: Date.now(), hasApiKey: !!API_KEY, storage: redis ? "redis" : "file" }));

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
    console.log(redis ? "Using Upstash Redis for playlist/cache storage." : "Using local JSON files for playlist/cache storage.");
  });
}

module.exports = app;
