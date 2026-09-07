// Synq frontend — YouTube-powered search, playlists, queue/shuffle/repeat, drag & drop.

// ===================== State =====================
const state = {
  user: null,              // { id, name, email } once logged in
  tracksById: new Map(),   // every track we've seen (search results, recent, playlist tracks)
  playlists: [],           // [{id,name,count}]
  recent: [],              // this account's recently-played, kept in sync with the server

  viewKind: "search",      // "search" | "recent" | a playlist id (starts with "pl_")
  rawView: [],
  view: [],

  queue: [],                // array of video ids
  queuePos: -1,
  shuffle: false,
  repeat: "off",            // "off" | "all" | "one"
};

// ===================== Icons (inline SVG, Feather-style) =====================
const ICONS = {
  play: `<svg class="icon" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg>`,
  pause: `<svg class="icon" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>`,
  x: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  edit: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>`,
  trash: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`,
  moreHorizontal: `<svg class="icon" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>`,
  grip: `<svg class="icon" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="9" cy="5" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="9" cy="19" r="1.4"/><circle cx="15" cy="5" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="15" cy="19" r="1.4"/></svg>`,
  music: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
  repeat: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`,
  repeatOne: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><text x="12" y="14.5" font-size="8" font-weight="700" text-anchor="middle" stroke="none" fill="currentColor">1</text></svg>`,
};

// ===================== YouTube player =====================
let ytPlayer = null;
let ytReady = false;
let pendingPlayId = null;
let progressTimerStarted = false;

window.onYouTubeIframeAPIReady = function () {
  ytPlayer = new YT.Player("yt-player-mount", {
    height: "100%",
    width: "100%",
    // `origin` matters more than the IFrame API docs let on: without it,
    // YouTube's embed-permission handshake can misfire specifically when the
    // page is loaded from a private-network IP (e.g. opening this over Wi-Fi
    // on a phone at http://192.168.x.x:3000) even though the exact same
    // video plays fine from localhost — every result failing with error 150
    // (not just restricted videos) is the signature of this, not of the
    // videos actually being embed-disabled.
    playerVars: { rel: 0, modestbranding: 1, playsinline: 1, origin: window.location.origin },
    events: {
      onReady: () => {
        ytReady = true;
        ytPlayer.setVolume(Number($("volume").value));
        if (pendingPlayId) { loadAndPlay(pendingPlayId); pendingPlayId = null; }
        startProgressTimer();
      },
      onStateChange: onPlayerStateChange,
      onError: (e) => onPlayerError(e),
    },
  });
};

function onPlayerStateChange(e) {
  if (e.data === YT.PlayerState.ENDED) next();
  else if (e.data === YT.PlayerState.PLAYING) {
    $("play").innerHTML = ICONS.pause;
    document.body.classList.add("is-playing"); // drives the decorative equalizer bars on the active track row
    requestWakeLock();
    setMediaSessionState("playing");
  } else if (e.data === YT.PlayerState.PAUSED) {
    $("play").innerHTML = ICONS.play;
    document.body.classList.remove("is-playing");
    releaseWakeLock();
    setMediaSessionState("paused");
  }
}

// ===================== Keep the screen awake while listening =====================
// Mobile browsers auto-lock the screen after a short idle timeout, and once
// locked, the YouTube embed (and the phone's own OS media policies) will
// pause it — a plain web page can't force video to keep playing through an
// actual manual lock-button press or a backgrounded tab, that's controlled
// by the OS/YouTube's player, not by this site's JS. What we *can* do is
// stop the automatic idle-timeout lock for as long as something is playing,
// which covers the far more common "screen dimmed and stopped my music"
// case. Wake Lock is released by the browser whenever the tab is hidden, so
// we re-acquire it on the next visibilitychange back to "visible".
let wakeLock = null;
async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch { /* permission denied or unsupported — playback still works, screen just may lock */ }
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && ytPlayer && ytPlayer.getPlayerState && ytPlayer.getPlayerState() === YT.PlayerState.PLAYING) {
    requestWakeLock();
  }
});

// ===================== Lock-screen / notification media controls =====================
function setMediaSessionState(state) {
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = state;
}
function updateMediaSessionMetadata(t) {
  if (!("mediaSession" in navigator)) return;
  if (!t) { navigator.mediaSession.metadata = null; return; }
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title,
    artist: t.artist,
    album: "Synq",
    artwork: t.thumbnail ? [{ src: t.thumbnail, sizes: "320x180", type: "image/jpeg" }] : [],
  });
}
function wireMediaSession() {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.setActionHandler("play", () => ytPlayer && ytPlayer.playVideo());
  navigator.mediaSession.setActionHandler("pause", () => ytPlayer && ytPlayer.pauseVideo());
  navigator.mediaSession.setActionHandler("previoustrack", () => prev());
  navigator.mediaSession.setActionHandler("nexttrack", () => next());
}

// Mobile browsers enforce autoplay policy much more strictly than desktop:
// a play command only "counts" as user-initiated if it fires within the
// same tap that triggered it. If the player wasn't fully initialized yet
// (loadVideoById gets queued via pendingPlayId until onReady fires later,
// asynchronously, outside the original tap), some phones will silently
// refuse to autoplay it. This nudges playback with an explicit playVideo()
// shortly after — harmless if it's already playing, but recovers the case
// where it loaded but didn't actually start.
function loadAndPlay(id) {
  ytPlayer.loadVideoById(id);
  setTimeout(() => {
    if (ytPlayer && ytPlayer.getPlayerState && ytPlayer.getPlayerState() !== YT.PlayerState.PLAYING) {
      ytPlayer.playVideo();
    }
  }, 500);
}

// YT.PlayerError codes: 2 invalid param, 5 HTML5 error, 100 removed/private,
// 101 & 150 embedding disabled by the video's owner (labels do this a lot on
// official music videos, to push viewers to youtube.com/the app instead —
// it's not something this site can work around; picking a different upload
// of the same song — lyric video, live version, fan upload — usually plays
// fine since those normally allow embedding).
function onPlayerError(e) {
  const code = e && e.data;
  console.error("YouTube player error", code);
  let msg = "This video can't be played here.";
  if (code === 101 || code === 150) msg = "This video's owner has blocked it from playing on other sites. Try a different result for the same song.";
  else if (code === 100) msg = "This video was removed or made private.";
  else if (code === 2) msg = "Couldn't play that video.";
  showToast(msg, true);
  // Don't leave the queue stuck on a track that will never play.
  setTimeout(() => next(), 900);
}

function startProgressTimer() {
  if (progressTimerStarted) return;
  progressTimerStarted = true;
  setInterval(() => {
    if (!ytPlayer || typeof ytPlayer.getDuration !== "function") return;
    let dur, cur;
    try { dur = ytPlayer.getDuration(); cur = ytPlayer.getCurrentTime(); } catch { return; }
    if (dur) {
      $("seek").value = (cur / dur) * 100 || 0;
      $("current").textContent = fmt(cur);
      $("duration").textContent = fmt(dur);
    }
  }, 500);
}

// ===================== API helper =====================
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    ...opts,
  });
  if (res.status === 401 && path !== "/api/auth/me" && !path.startsWith("/api/auth/")) {
    // Session missing/expired — drop back to the login screen instead of
    // leaving the app stuck showing a generic error toast.
    showAuthScreen();
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data?.error) msg = data.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return null;
}

// ===================== Helpers =====================
const fmt = (t) => (!isFinite(t) || t == null) ? "0:00" : `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = (id) => document.getElementById(id);
const isPlaylistView = () => typeof state.viewKind === "string" && state.viewKind.startsWith("pl_");

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

let toastTimer = null;
function showToast(msg, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.remove("hide");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hide"), 3200);
}

let confirmResolve = null;
function askConfirm(text, okLabel = "Remove") {
  return new Promise((resolve) => {
    $("confirm-text").textContent = text;
    $("confirm-ok").textContent = okLabel;
    $("confirm-modal").classList.remove("hide");
    confirmResolve = resolve;
  });
}
function closeConfirm(result) {
  $("confirm-modal").classList.add("hide");
  if (confirmResolve) { confirmResolve(result); confirmResolve = null; }
}

// ===================== Recently played (per-account, server-backed) =====================
// Kept as an in-memory cache (state.recent) so every call site can read it
// synchronously like before; updated optimistically here and persisted to
// the account's own server-side list in the background.
function getRecent() {
  return state.recent;
}
function pushRecent(t) {
  state.recent = state.recent.filter((x) => x.id !== t.id);
  state.recent.unshift({ id: t.id, title: t.title, artist: t.artist, thumbnail: t.thumbnail, duration: t.duration });
  state.recent = state.recent.slice(0, 40);
  api("/api/recent", { method: "POST", body: JSON.stringify({ track: t }) }).catch(() => { /* best-effort */ });
}
async function clearRecent() {
  state.recent = [];
  await api("/api/recent", { method: "DELETE" });
}

// ===================== Playlists =====================
async function fetchPlaylists() {
  const d = await api("/api/playlists");
  state.playlists = d.playlists || [];
  renderPlaylists();
}

// ===================== View management =====================
function setActiveNav(kind) {
  $("nav-home").classList.toggle("active", kind === "home");
  $("nav-search").classList.toggle("active", kind === "search");
  $("nav-recent").classList.toggle("active", kind === "recent");
  document.querySelectorAll(".playlist-row").forEach((r) => r.classList.toggle("active", r.dataset.id === kind));
  $("mnav-home").classList.toggle("active", kind === "home");
  $("mnav-search").classList.toggle("active", kind === "search");
}

function emptyStateTextFor(kind) {
  if (kind === "search") return "Search YouTube above, or paste a video/playlist link, to get started.";
  if (kind === "recent") return "Nothing played yet.";
  return "This playlist is empty — search for tracks and add them here.";
}

// Home is its own full view (separate from the track-table), so every other
// view flips these two back before rendering its own list.
function showTrackListUI() {
  $("home-view").classList.add("hide");
  $("track-table").classList.remove("hide");
}

function selectHome() {
  state.viewKind = "home";
  setActiveNav("home");
  $("view-title").textContent = "Home";
  $("view-count").textContent = "";
  $("view-actions").classList.add("hide");
  $("track-table").classList.add("hide");
  $("empty-state").classList.add("hide");
  $("home-view").classList.remove("hide");
  renderHome();
}

function homeCardHtml(id, title, sub, thumb) {
  return `
    <div class="home-card" data-id="${id}">
      <div class="home-card-art-wrap">
        ${thumb ? `<img class="home-card-art" src="${thumb}" alt="" loading="lazy" />` : `<div class="home-card-art">${ICONS.music}</div>`}
        <span class="home-card-play" aria-hidden="true">${ICONS.play || '▶'}</span>
      </div>
      <div class="home-card-title">${escapeHtml(title)}</div>
      <div class="home-card-sub">${escapeHtml(sub)}</div>
    </div>
  `;
}

const HOME_GENRES = ["Pop hits", "Hip-Hop", "Rock classics", "Chill lo-fi", "Workout mix", "Bollywood", "Throwback 2000s", "Jazz"];

function renderHome() {
  const recent = getRecent();
  const recentEl = $("home-recent");
  recentEl.innerHTML = recent.length
    ? recent.slice(0, 12).map((t) => homeCardHtml(t.id, t.title, t.artist, t.thumbnail)).join("")
    : `<div class="home-empty-hint">Nothing played yet — search for a song to get started.</div>`;
  recentEl.querySelectorAll(".home-card").forEach((card) => {
    card.addEventListener("click", () => {
      const t = recent.find((x) => x.id === card.dataset.id);
      if (!t) return;
      state.tracksById.set(t.id, t);
      buildQueueFrom(recent, t.id);
    });
  });

  const plEl = $("home-playlists");
  plEl.innerHTML = state.playlists.length
    ? state.playlists.slice(0, 12).map((p) => homeCardHtml(p.id, p.name, `${p.count} track${p.count === 1 ? "" : "s"}`, null)).join("")
    : `<div class="home-empty-hint">No playlists yet — create one from the sidebar.</div>`;
  plEl.querySelectorAll(".home-card").forEach((card) => {
    card.addEventListener("click", () => selectPlaylist(card.dataset.id));
  });

  const genresEl = $("home-genres");
  genresEl.innerHTML = HOME_GENRES.map((g) => `<button class="home-chip" data-q="${escapeHtml(g)}">${escapeHtml(g)}</button>`).join("");
  genresEl.querySelectorAll(".home-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      $("search").value = chip.dataset.q;
      handleSearchSubmit(chip.dataset.q);
    });
  });

  loadSuggestions(); // fire-and-forget — pops in once the server responds
}

async function loadSuggestions() {
  const el = $("home-suggested");
  el.innerHTML = `<div class="home-empty-hint">Loading suggestions…</div>`;
  try {
    const d = await api("/api/recommendations");
    const tracks = d.tracks || [];
    if (!tracks.length) {
      el.innerHTML = `<div class="home-empty-hint">Play a few songs and we'll start suggesting more here.</div>`;
      return;
    }
    tracks.forEach((t) => state.tracksById.set(t.id, t));
    el.innerHTML = tracks.map((t) => homeCardHtml(t.id, t.title, t.artist, t.thumbnail)).join("");
    el.querySelectorAll(".home-card").forEach((card) => {
      card.addEventListener("click", () => {
        const t = tracks.find((x) => x.id === card.dataset.id);
        if (t) buildQueueFrom(tracks, t.id);
      });
    });
  } catch {
    el.innerHTML = `<div class="home-empty-hint">Couldn't load suggestions right now.</div>`;
  }
}

function selectSearch() {
  showTrackListUI();
  state.viewKind = "search";
  setActiveNav("search");
  $("view-title").textContent = "Search";
  $("empty-state-text").textContent = emptyStateTextFor("search");
  state.rawView = []; state.view = [];
  renderTracks();
}

function selectRecent() {
  showTrackListUI();
  state.viewKind = "recent";
  setActiveNav("recent");
  $("view-title").textContent = "Recently played";
  $("empty-state-text").textContent = emptyStateTextFor("recent");
  const list = getRecent();
  list.forEach((t) => state.tracksById.set(t.id, t));
  state.rawView = list; state.view = list;
  renderTracks();
}

async function selectPlaylist(pid) {
  showTrackListUI();
  state.viewKind = pid;
  setActiveNav(pid);
  const pl = state.playlists.find((p) => p.id === pid);
  $("view-title").textContent = pl ? pl.name : "Playlist";
  $("empty-state-text").textContent = emptyStateTextFor(pid);
  try {
    const d = await api(`/api/playlists/${pid}/tracks`);
    d.tracks.forEach((t) => state.tracksById.set(t.id, t));
    state.rawView = d.tracks || [];
    state.view = state.rawView;
  } catch (e) {
    showToast(e.message, true);
    state.rawView = []; state.view = [];
  }
  renderTracks();
}

async function handleSearchSubmit(raw) {
  const q = raw.trim();
  if (!q) return;
  showTrackListUI();
  state.viewKind = "search";
  setActiveNav("search");
  $("view-title").textContent = `Searching for "${q}"…`;
  $("empty-state-text").textContent = "Searching…";
  state.rawView = []; state.view = [];
  renderTracks();

  const looksLikeLinkOrId = /youtu\.?be/i.test(q) || /^[\w-]{11}$/.test(q);
  try {
    let tracks;
    if (looksLikeLinkOrId) {
      const d = await api("/api/resolve", { method: "POST", body: JSON.stringify({ input: q }) });
      tracks = [d.track];
    } else {
      const d = await api(`/api/search?q=${encodeURIComponent(q)}`);
      tracks = d.tracks || [];
    }
    tracks.forEach((t) => state.tracksById.set(t.id, t));
    state.rawView = tracks; state.view = tracks;
    $("view-title").textContent = `Results for "${q}"`;
    $("empty-state-text").textContent = "No results.";
  } catch (e) {
    showToast(e.message, true);
    $("view-title").textContent = "Search";
    $("empty-state-text").textContent = e.message;
  }
  renderTracks();
}

// ===================== Rendering =====================
function renderPlaylists() {
  const el = $("playlist-list");
  el.innerHTML = "";
  state.playlists.forEach((p) => {
    const row = document.createElement("div");
    row.className = "playlist-row" + (state.viewKind === p.id ? " active" : "");
    row.dataset.id = p.id;
    row.innerHTML = `
      <span class="pl-name">${escapeHtml(p.name)}</span>
      <span class="pl-count">${p.count}</span>
      <span class="pl-actions">
        <button class="icon-btn pl-rename" title="Rename" aria-label="Rename">${ICONS.edit}</button>
        <button class="icon-btn pl-delete" title="Delete" aria-label="Delete">${ICONS.trash}</button>
      </span>
    `;
    row.addEventListener("click", (e) => {
      if (e.target.closest(".pl-actions")) return;
      selectPlaylist(p.id);
      closeMobileSidebar();
    });
    row.querySelector(".pl-rename").addEventListener("click", (e) => { e.stopPropagation(); openRenamePlaylist(p); });
    row.querySelector(".pl-delete").addEventListener("click", (e) => { e.stopPropagation(); deletePlaylist(p); });

    row.addEventListener("dragover", (e) => { e.preventDefault(); row.classList.add("drop-target"); });
    row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
    row.addEventListener("drop", async (e) => {
      e.preventDefault();
      row.classList.remove("drop-target");
      const trackId = e.dataTransfer.getData("text/plain");
      if (!trackId) return;
      try {
        await addTrackToPlaylist(p.id, trackId);
        showToast(`Added to "${p.name}"`);
        await fetchPlaylists();
      } catch (err) { showToast(err.message, true); }
    });

    el.appendChild(row);
  });

  const menuPl = $("menu-playlists");
  menuPl.innerHTML = state.playlists.map((p) =>
    `<button class="mp-item" data-pid="${p.id}">${escapeHtml(p.name)}</button>`
  ).join("") || `<div class="muted small" style="padding:.3rem .6rem">No playlists yet</div>`;
}

async function addTrackToPlaylist(pid, trackId) {
  const t = state.tracksById.get(trackId);
  const meta = t ? { title: t.title, artist: t.artist, thumbnail: t.thumbnail, duration: t.duration } : undefined;
  return api(`/api/playlists/${pid}/tracks`, { method: "POST", body: JSON.stringify({ trackId, meta }) });
}

function trackArtHtml(t) {
  const art = t.thumbnail
    ? `<img class="track-art" src="${t.thumbnail}" alt="" loading="lazy" />`
    : `<div class="track-art placeholder">${ICONS.music}</div>`;
  // The eq badge itself is always in the DOM but only shown by CSS on
  // .track.active — that way it stays correctly positioned as the "active"
  // class moves between rows (e.g. on next/prev) without a full re-render,
  // and only animates while body.is-playing reflects the real player state.
  return `<div class="track-art-wrap">${art}<span class="track-eq" aria-hidden="true"><i></i><i></i><i></i></span></div>`;
}

function renderTracks() {
  const el = $("track-table");
  el.innerHTML = "";
  const reorderable = isPlaylistView();
  const currentId = state.queuePos >= 0 ? state.queue[state.queuePos] : null;

  $("view-count").textContent = state.view.length ? `${state.view.length} track${state.view.length === 1 ? "" : "s"}` : "";
  $("view-actions").classList.toggle("hide", state.view.length === 0);
  $("empty-state").classList.toggle("hide", state.rawView.length !== 0);

  state.view.forEach((t, idx) => {
    const row = document.createElement("div");
    row.className = "track" + (t.id === currentId ? " active" : "");
    row.dataset.id = t.id;
    row.setAttribute("role", "listitem");
    row.draggable = true;

    row.innerHTML = `
      <span class="drag-handle">${reorderable ? ICONS.grip : ""}</span>
      ${trackArtHtml(t)}
      <div class="meta">
        <div class="title">${escapeHtml(t.title)}</div>
        <div class="artist">${escapeHtml(t.artist)}</div>
      </div>
      <span class="duration">${t.duration ? fmt(t.duration) : ""}</span>
      <button class="kebab" aria-label="More options">${ICONS.moreHorizontal}</button>
    `;

    row.addEventListener("click", (e) => {
      if (e.target.closest(".kebab")) return;
      buildQueueFrom(state.view, t.id);
    });

    row.querySelector(".kebab").addEventListener("click", (e) => {
      e.stopPropagation();
      openTrackMenu(e.currentTarget, t);
    });

    row.addEventListener("dragstart", (e) => {
      state.dragFromIndex = idx;
      row.classList.add("dragging");
      e.dataTransfer.setData("text/plain", t.id);
      e.dataTransfer.effectAllowed = "move";
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      document.querySelectorAll(".track").forEach((r) => r.classList.remove("drag-over-top", "drag-over-bottom"));
      state.dragFromIndex = null;
    });

    if (reorderable) {
      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        const rect = row.getBoundingClientRect();
        const before = (e.clientY - rect.top) < rect.height / 2;
        row.classList.toggle("drag-over-top", before);
        row.classList.toggle("drag-over-bottom", !before);
      });
      row.addEventListener("dragleave", () => row.classList.remove("drag-over-top", "drag-over-bottom"));
      row.addEventListener("drop", async (e) => {
        e.preventDefault();
        const before = row.classList.contains("drag-over-top");
        row.classList.remove("drag-over-top", "drag-over-bottom");
        const fromIndex = state.dragFromIndex;
        if (fromIndex == null || fromIndex === idx) return;

        const list = state.view.slice();
        const [moved] = list.splice(fromIndex, 1);
        let targetIndex = list.findIndex((x) => x.id === t.id);
        if (targetIndex === -1) targetIndex = list.length;
        list.splice(before ? targetIndex : targetIndex + 1, 0, moved);

        state.view = list;
        renderTracks();

        try {
          await api(`/api/playlists/${state.viewKind}/order`, {
            method: "PUT",
            body: JSON.stringify({ trackIds: list.map((x) => x.id) }),
          });
        } catch (err) {
          showToast(err.message, true);
        } finally {
          await selectPlaylist(state.viewKind);
        }
      });
    }

    el.appendChild(row);
  });
}

function renderQueue() {
  const el = $("queue-list");
  el.innerHTML = "";
  if (!state.queue.length) {
    el.innerHTML = `<div class="queue-empty">Queue is empty. Play a track to get started.</div>`;
    return;
  }
  state.queue.forEach((id, idx) => {
    const t = state.tracksById.get(id);
    if (!t) return;
    const row = document.createElement("div");
    row.className = "queue-item" + (idx === state.queuePos ? " current" : "");
    row.draggable = true;
    row.innerHTML = `
      <span class="qi-marker">${idx === state.queuePos ? ICONS.play : ""}</span>
      <span class="qi-title">${escapeHtml(t.title)} <span class="muted small">— ${escapeHtml(t.artist)}</span></span>
      <button class="qi-remove" aria-label="Remove from queue">${ICONS.x}</button>
    `;
    row.addEventListener("click", (e) => {
      if (e.target.closest(".qi-remove")) return;
      state.queuePos = idx;
      playCurrentQueueItem();
    });
    row.querySelector(".qi-remove").addEventListener("click", (e) => {
      e.stopPropagation();
      removeFromQueue(idx);
    });

    row.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/x-queue-index", String(idx));
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
    row.addEventListener("dragover", (e) => e.preventDefault());
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      const from = parseInt(e.dataTransfer.getData("text/x-queue-index"), 10);
      if (Number.isNaN(from) || from === idx) return;
      const currentId = state.queue[state.queuePos];
      const q = state.queue.slice();
      const [moved] = q.splice(from, 1);
      const to = q.findIndex((qid) => qid === id);
      q.splice(to, 0, moved);
      state.queue = q;
      state.queuePos = state.queue.indexOf(currentId);
      renderQueue();
    });

    el.appendChild(row);
  });
}

function updateNowPlayingUI(t) {
  $("track-title").textContent = t ? t.title : "Nothing playing";
  $("track-artist").textContent = t ? t.artist : "Search above to start";
  document.querySelectorAll(".track").forEach((x) => x.classList.toggle("active", t && x.dataset.id === t.id));
  updateMediaSessionMetadata(t);
  setBackdrop(t && t.thumbnail);
}

// ===================== Ambient backdrop (Apple Music style glow) =====================
// Two stacked full-viewport layers, crossfaded — the currently-playing
// track's thumbnail, heavily blurred/darkened via pure CSS filters. Avoids
// canvas-based color extraction (and the CORS/tainted-canvas issues that
// comes with reading pixels off YouTube's thumbnail CDN) entirely.
let backdropFront = "a";
let lastBackdropUrl = null;
function setBackdrop(url) {
  if (!url || url === lastBackdropUrl) return;
  lastBackdropUrl = url;
  const front = $("backdrop-" + backdropFront);
  const nextKey = backdropFront === "a" ? "b" : "a";
  const back = $("backdrop-" + nextKey);
  back.style.backgroundImage = `url("${url}")`;
  requestAnimationFrame(() => {
    back.classList.add("visible");
    front.classList.remove("visible");
  });
  backdropFront = nextKey;
}

// ===================== Queue / playback =====================
function buildQueueFrom(list, startId) {
  const ids = list.map((t) => t.id);
  let ordered;
  if (state.shuffle) {
    const rest = shuffleArray(ids.filter((id) => id !== startId));
    ordered = [startId, ...rest];
  } else {
    const i = ids.indexOf(startId);
    ordered = i > 0 ? [...ids.slice(i), ...ids.slice(0, i)] : ids;
  }
  state.queue = ordered;
  state.queuePos = 0;
  playCurrentQueueItem();
}

function shufflePlayView() {
  if (!state.view.length) return;
  state.shuffle = true;
  $("btn-shuffle").classList.add("on");
  $("btn-shuffle-view").classList.add("on");
  state.queue = shuffleArray(state.view.map((t) => t.id));
  state.queuePos = 0;
  playCurrentQueueItem();
}

function playCurrentQueueItem() {
  const id = state.queue[state.queuePos];
  const t = state.tracksById.get(id);
  if (!t) return;
  updateNowPlayingUI(t);
  renderQueue();
  pushRecent(t);
  if (!ytReady || !ytPlayer) { pendingPlayId = id; return; }
  loadAndPlay(id);
}

function next() {
  if (!state.queue.length) return;
  if (state.repeat === "one") { if (ytPlayer) { ytPlayer.seekTo(0, true); ytPlayer.playVideo(); } return; }
  if (state.queuePos + 1 < state.queue.length) { state.queuePos++; playCurrentQueueItem(); return; }
  if (state.repeat === "all") { state.queuePos = 0; playCurrentQueueItem(); return; }
  if (ytPlayer) ytPlayer.pauseVideo();
}

function prev() {
  if (!state.queue.length) return;
  const cur = ytPlayer ? ytPlayer.getCurrentTime() : 0;
  if (cur > 3) { if (ytPlayer) ytPlayer.seekTo(0, true); return; }
  if (state.queuePos - 1 >= 0) { state.queuePos--; playCurrentQueueItem(); return; }
  if (state.repeat === "all") { state.queuePos = state.queue.length - 1; playCurrentQueueItem(); return; }
  if (ytPlayer) ytPlayer.seekTo(0, true);
}

function addToQueue(trackId) {
  if (!state.queue.length) { buildQueueFrom([state.tracksById.get(trackId)], trackId); return; }
  state.queue.push(trackId);
  renderQueue();
  showToast("Added to queue");
}

function playNextInQueue(trackId) {
  if (!state.queue.length) { buildQueueFrom([state.tracksById.get(trackId)], trackId); return; }
  state.queue.splice(state.queuePos + 1, 0, trackId);
  renderQueue();
  showToast("Will play next");
}

function removeFromQueue(idx) {
  const wasCurrent = idx === state.queuePos;
  state.queue.splice(idx, 1);
  if (idx < state.queuePos) state.queuePos--;
  if (wasCurrent) {
    if (state.queuePos >= state.queue.length) state.queuePos = state.queue.length - 1;
    if (state.queuePos >= 0) playCurrentQueueItem();
    else { if (ytPlayer) ytPlayer.stopVideo(); updateNowPlayingUI(null); }
  }
  renderQueue();
}

function toggleShuffle() {
  state.shuffle = !state.shuffle;
  $("btn-shuffle").classList.toggle("on", state.shuffle);
  $("btn-shuffle-view").classList.toggle("on", state.shuffle);
  if (state.shuffle && state.queue.length) {
    const currentId = state.queue[state.queuePos];
    const rest = shuffleArray(state.queue.filter((id, i) => i !== state.queuePos));
    state.queue = [currentId, ...rest];
    state.queuePos = 0;
    renderQueue();
  }
}

function cycleRepeat() {
  state.repeat = state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off";
  const btn = $("btn-repeat");
  btn.classList.toggle("on", state.repeat !== "off");
  btn.innerHTML = state.repeat === "one" ? ICONS.repeatOne : ICONS.repeat;
}

// ===================== Track menu (kebab) =====================
function openTrackMenu(anchorEl, track) {
  const menu = $("track-menu");
  const rect = anchorEl.getBoundingClientRect();
  menu.style.left = Math.min(rect.left, window.innerWidth - 220) + "px";
  menu.style.top = Math.min(rect.bottom + 4, window.innerHeight - 260) + "px";
  menu.classList.remove("hide");

  const removeBtn = menu.querySelector('[data-action="remove-from-playlist"]');
  removeBtn.classList.toggle("hide", !isPlaylistView());

  menu.querySelectorAll("[data-action]").forEach((btn) => {
    btn.onclick = async () => {
      closeTrackMenu();
      const action = btn.dataset.action;
      if (action === "play-next") playNextInQueue(track.id);
      else if (action === "add-queue") addToQueue(track.id);
      else if (action === "remove-from-playlist") await removeFromCurrentPlaylist(track);
    };
  });

  $("menu-playlists").querySelectorAll(".mp-item").forEach((btn) => {
    btn.onclick = async () => {
      closeTrackMenu();
      try {
        await addTrackToPlaylist(btn.dataset.pid, track.id);
        showToast("Added to playlist");
        await fetchPlaylists();
      } catch (e) { showToast(e.message, true); }
    };
  });
}
function closeTrackMenu() { $("track-menu").classList.add("hide"); }

// ===================== Playlist mutations =====================
async function removeFromCurrentPlaylist(track) {
  try {
    await api(`/api/playlists/${state.viewKind}/tracks`, { method: "DELETE", body: JSON.stringify({ trackId: track.id }) });
    await selectPlaylist(state.viewKind);
    await fetchPlaylists();
    showToast("Removed from playlist");
  } catch (e) { showToast(e.message, true); }
}

async function deletePlaylist(p) {
  const ok = await askConfirm(`Delete playlist "${p.name}"? This can't be undone.`, "Delete");
  if (!ok) return;
  try {
    await api(`/api/playlists/${p.id}`, { method: "DELETE" });
    if (state.viewKind === p.id) selectSearch();
    await fetchPlaylists();
    showToast("Playlist deleted");
  } catch (e) { showToast(e.message, true); }
}

function openRenamePlaylist(p) {
  $("renamepl-name").value = p.name;
  $("renamepl-modal").classList.remove("hide");
  $("renamepl-modal").dataset.pid = p.id;
  setTimeout(() => $("renamepl-name").focus(), 30);
}

// ===================== Import playlist =====================
function openImportModal() {
  $("import-url").value = "";
  $("import-status").textContent = "";
  $("import-modal").classList.remove("hide");
  setTimeout(() => $("import-url").focus(), 30);
}
function closeImportModal() { $("import-modal").classList.add("hide"); }

async function doImport() {
  const url = $("import-url").value.trim();
  if (!url) return;
  $("import-status").textContent = "Importing… large playlists can take a little while.";
  try {
    const p = await api("/api/import-playlist", { method: "POST", body: JSON.stringify({ url }) });
    closeImportModal();
    await fetchPlaylists();
    await selectPlaylist(p.id);
    showToast(`Imported ${p.tracks.length} tracks`);
  } catch (e) {
    $("import-status").textContent = e.message;
  }
}

// ===================== Video panel expand/collapse =====================
function wireVideoPanel() {
  $("video-expand").addEventListener("click", () => {
    const panel = $("video-panel");
    panel.classList.toggle("expanded");
  });
}

// ===================== Mobile: library sheet =====================
function openMobileSidebar() { $("sidebar").classList.add("mobile-open"); }
function closeMobileSidebar() { $("sidebar").classList.remove("mobile-open"); }

function wireMobileNav() {
  $("mnav-home").addEventListener("click", () => { selectHome(); closeMobileSidebar(); });
  $("mnav-search").addEventListener("click", () => {
    selectSearch();
    closeMobileSidebar();
    setTimeout(() => $("search").focus(), 30);
  });
  $("mnav-library").addEventListener("click", openMobileSidebar);
  $("mnav-settings").addEventListener("click", openSettingsModal);
  $("sidebar-close").addEventListener("click", closeMobileSidebar);
}

// ===================== Settings modal =====================
function openSettingsModal() {
  $("settings-modal").classList.remove("hide");
  populateSettings();
}
function closeSettingsModal() { $("settings-modal").classList.add("hide"); }

async function populateSettings() {
  const apikeyBadge = $("settings-apikey");
  const storageBadge = $("settings-storage");
  const userBadge = $("settings-user");
  userBadge.textContent = state.user ? (state.user.name || state.user.email) : "—";
  apikeyBadge.textContent = "Checking…"; apikeyBadge.className = "badge";
  storageBadge.textContent = "Checking…"; storageBadge.className = "badge";
  try {
    const d = await api("/api/ping");
    apikeyBadge.textContent = d.hasApiKey ? "Configured" : "Missing";
    apikeyBadge.className = "badge " + (d.hasApiKey ? "good" : "warn");
    storageBadge.textContent = d.storage === "redis" ? "Redis (persistent)" : "Local file (resets on restart)";
    storageBadge.className = "badge " + (d.storage === "redis" ? "good" : "warn");
  } catch {
    apikeyBadge.textContent = "Unknown";
    storageBadge.textContent = "Unknown";
  }
}

function wireSettingsModal() {
  $("btn-settings").addEventListener("click", openSettingsModal);
  $("settings-close").addEventListener("click", closeSettingsModal);
  $("settings-modal").addEventListener("click", (e) => { if (e.target.id === "settings-modal") closeSettingsModal(); });
  $("settings-clear-recent").addEventListener("click", async () => {
    try {
      await clearRecent();
      showToast("Cleared recently played");
      if (state.viewKind === "recent") selectRecent();
      if (state.viewKind === "home") renderHome();
    } catch (e) {
      showToast(e.message, true);
    }
  });
  $("settings-logout").addEventListener("click", async () => {
    try { await api("/api/auth/logout", { method: "POST" }); } catch { /* best-effort */ }
    state.user = null;
    closeSettingsModal();
    showAuthScreen();
  });
}

// ===================== Mobile: full-screen Now Playing sheet =====================
// Re-parents the existing video-panel/pb-meta/pb-center nodes (with all their
// wired-up listeners intact) from the compact player bar into the sheet, and
// back again on collapse — avoids ever duplicating an id or a control.
function wireNowPlayingSheet() {
  const pbNow = document.querySelector(".pb-now");
  const footer = document.querySelector(".player-bar");
  const pbRight = document.querySelector(".pb-right");
  const isMobile = () => window.matchMedia("(max-width: 900px)").matches;

  function expandNowPlaying() {
    if (!isMobile()) return;
    const sheet = $("now-playing-sheet");
    sheet.classList.remove("hide");
    $("np-body").appendChild($("video-panel"));
    $("np-body").appendChild($("pb-meta"));
    $("np-body").appendChild($("pb-center"));
    requestAnimationFrame(() => sheet.classList.add("open"));
  }

  function collapseNowPlaying() {
    const sheet = $("now-playing-sheet");
    sheet.classList.remove("open");
    pbNow.insertBefore($("video-panel"), pbNow.firstChild);
    pbNow.appendChild($("pb-meta"));
    footer.insertBefore($("pb-center"), pbRight);
    setTimeout(() => sheet.classList.add("hide"), 320);
  }

  pbNow.addEventListener("click", (e) => {
    if (e.target.closest("#video-expand")) return;
    expandNowPlaying();
  });
  $("np-collapse").addEventListener("click", collapseNowPlaying);
  $("np-queue-btn").addEventListener("click", () => {
    collapseNowPlaying();
    $("btn-queue").click();
  });
}

// ===================== Wiring =====================
function wireTopLevel() {
  $("search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    handleSearchSubmit($("search").value);
  });
  $("nav-home").addEventListener("click", () => { selectHome(); closeMobileSidebar(); });
  $("nav-search").addEventListener("click", () => { selectSearch(); closeMobileSidebar(); });
  $("nav-recent").addEventListener("click", () => { selectRecent(); closeMobileSidebar(); });

  $("btn-queue").addEventListener("click", () => {
    const drawer = $("queue-drawer");
    const body = document.querySelector(".body");
    const showing = drawer.classList.toggle("hide");
    body.classList.toggle("with-queue", !showing);
    if (!showing) renderQueue();
  });
  $("btn-close-queue").addEventListener("click", () => {
    $("queue-drawer").classList.add("hide");
    document.querySelector(".body").classList.remove("with-queue");
  });

  $("btn-play-view").addEventListener("click", () => { if (state.view[0]) buildQueueFrom(state.view, state.view[0].id); });
  $("btn-shuffle-view").addEventListener("click", shufflePlayView);

  $("btn-import").addEventListener("click", openImportModal);
  $("import-close").addEventListener("click", closeImportModal);
  $("import-cancel").addEventListener("click", closeImportModal);
  $("import-ok").addEventListener("click", doImport);
  $("import-url").addEventListener("keydown", (e) => { if (e.key === "Enter") doImport(); });

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#track-menu") && !e.target.closest(".kebab")) closeTrackMenu();
  });
}

function wirePlaylistModals() {
  $("btn-new-playlist").addEventListener("click", () => {
    $("newpl-name").value = "";
    $("newpl-modal").classList.remove("hide");
    setTimeout(() => $("newpl-name").focus(), 30);
  });
  $("newpl-cancel").addEventListener("click", () => $("newpl-modal").classList.add("hide"));
  $("newpl-ok").addEventListener("click", createPlaylistFromModal);
  $("newpl-name").addEventListener("keydown", (e) => { if (e.key === "Enter") createPlaylistFromModal(); });

  async function createPlaylistFromModal() {
    const name = $("newpl-name").value.trim();
    if (!name) return;
    try {
      const p = await api("/api/playlists", { method: "POST", body: JSON.stringify({ name }) });
      $("newpl-modal").classList.add("hide");
      await fetchPlaylists();
      selectPlaylist(p.id);
    } catch (e) { showToast(e.message, true); }
  }

  $("renamepl-cancel").addEventListener("click", () => $("renamepl-modal").classList.add("hide"));
  $("renamepl-ok").addEventListener("click", renamePlaylistFromModal);
  $("renamepl-name").addEventListener("keydown", (e) => { if (e.key === "Enter") renamePlaylistFromModal(); });

  async function renamePlaylistFromModal() {
    const name = $("renamepl-name").value.trim();
    const pid = $("renamepl-modal").dataset.pid;
    if (!name || !pid) return;
    try {
      await api(`/api/playlists/${pid}`, { method: "PUT", body: JSON.stringify({ name }) });
      $("renamepl-modal").classList.add("hide");
      await fetchPlaylists();
      if (state.viewKind === pid) $("view-title").textContent = name;
    } catch (e) { showToast(e.message, true); }
  }

  $("confirm-cancel").addEventListener("click", () => closeConfirm(false));
  $("confirm-ok").addEventListener("click", () => closeConfirm(true));
}

function wirePlayerControls() {
  const seek = $("seek"), volume = $("volume");
  seek.addEventListener("input", () => {
    if (ytPlayer && ytPlayer.getDuration()) ytPlayer.seekTo((seek.value / 100) * ytPlayer.getDuration(), true);
  });
  volume.addEventListener("input", () => { if (ytPlayer) ytPlayer.setVolume(Number(volume.value)); });

  $("play").addEventListener("click", () => {
    if (!ytPlayer) return;
    const s = ytPlayer.getPlayerState();
    if (s === YT.PlayerState.PLAYING) ytPlayer.pauseVideo();
    else ytPlayer.playVideo();
  });
  $("next").addEventListener("click", next);
  $("prev").addEventListener("click", prev);
  $("btn-shuffle").addEventListener("click", toggleShuffle);
  $("btn-repeat").addEventListener("click", cycleRepeat);

  window.addEventListener("keydown", (ev) => {
    const tag = ev.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (ev.code === "Space") { ev.preventDefault(); $("play").click(); }
    if (ev.code === "ArrowRight") next();
    if (ev.code === "ArrowLeft") prev();
  });
}

// ===================== Auth screen (sign up / log in) =====================
function showAuthScreen() {
  state.user = null;
  document.querySelector(".app").classList.add("hide");
  $("auth-screen").classList.remove("hide");
}

async function enterApp(user) {
  state.user = user;
  $("auth-screen").classList.add("hide");
  document.querySelector(".app").classList.remove("hide");
  selectHome();
  try {
    state.recent = (await api("/api/recent")).tracks || [];
  } catch {
    state.recent = [];
  }
  try {
    await fetchPlaylists();
  } catch (e) {
    showToast("Failed to load playlists: " + e.message, true);
  }
  if (state.viewKind === "home") renderHome();
}

async function checkAuth() {
  try {
    const d = await api("/api/auth/me");
    if (d && d.user) { await enterApp(d.user); return; }
  } catch { /* fall through to the login screen */ }
  showAuthScreen();
}

function wireAuthScreen() {
  let mode = "login";
  const nameField = $("auth-name");
  const errEl = $("auth-error");

  function setMode(m) {
    mode = m;
    $("auth-tab-login").classList.toggle("active", m === "login");
    $("auth-tab-signup").classList.toggle("active", m === "signup");
    nameField.classList.toggle("hide", m === "login");
    $("auth-submit").textContent = m === "login" ? "Log in" : "Sign up";
    $("auth-password").setAttribute("autocomplete", m === "login" ? "current-password" : "new-password");
    errEl.classList.add("hide");
  }
  $("auth-tab-login").addEventListener("click", () => setMode("login"));
  $("auth-tab-signup").addEventListener("click", () => setMode("signup"));

  $("auth-demo-btn").addEventListener("click", async () => {
    setMode("login");
    errEl.classList.add("hide");
    const btn = $("auth-demo-btn");
    btn.disabled = true;
    try {
      const d = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "demo@synq.app", password: "SynqDemo123" }),
      });
      $("auth-form").reset();
      await enterApp(d.user);
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove("hide");
    } finally {
      btn.disabled = false;
    }
  });

  $("auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("auth-email").value.trim();
    const password = $("auth-password").value;
    const name = nameField.value.trim();
    errEl.classList.add("hide");
    const btn = $("auth-submit");
    btn.disabled = true;
    try {
      const path = mode === "login" ? "/api/auth/login" : "/api/auth/signup";
      const body = mode === "login" ? { email, password } : { email, password, name };
      const d = await api(path, { method: "POST", body: JSON.stringify(body) });
      $("auth-form").reset();
      await enterApp(d.user);
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove("hide");
    } finally {
      btn.disabled = false;
    }
  });
}

// ===================== Boot =====================
window.addEventListener("DOMContentLoaded", async () => {
  wirePlayerControls();
  wireTopLevel();
  wirePlaylistModals();
  wireVideoPanel();
  wireMediaSession();
  wireMobileNav();
  wireSettingsModal();
  wireNowPlayingSheet();
  wireAuthScreen();
  await checkAuth();
});
