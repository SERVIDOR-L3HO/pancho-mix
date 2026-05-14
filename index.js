const express = require("express");
const cheerio = require("cheerio");

const app = express();
app.use(express.json());

const BASE_URL = "https://www.musica.com";
const SOUNDFLY_BASE = "https://soundfly.es";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ─── In-memory cache ──────────────────────────────────────────────────────────
const songCache = {};       // genre → { songs, ts }
const ytCache = {};         // musicaId → youtubeId
const searchCache = {};     // query → { results, ts }
const CACHE_TTL = 10 * 60 * 1000; // 10 min

// ─── HTTP helper ──────────────────────────────────────────────────────────────
async function fetchHtml(url, timeout = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        "Cache-Control": "no-cache",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── musica.com scrapers ──────────────────────────────────────────────────────

const GENRE_SLUG = {
  pop: "pop",
  reggaeton: "reggaeton",
  rock: "rock",
  latina: "musica-latina",
  "hip-hop": "hip-hop",
  trap: "trap",
  indie: "musica-indie",
  electronica: "musica-electronica",
};

async function getSongsFromPlaylist(genre, limit = 20) {
  const slug = GENRE_SLUG[genre.toLowerCase()] || genre.toLowerCase();
  const url = `${BASE_URL}/letras.asp?playlist=novedades-${slug}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const songs = [];
  const seen = new Set();

  $("ul.listado-letras li a[href*='letra=']").each((_, el) => {
    const href = $(el).attr("href") || "";
    const match = href.match(/letra=(\d+)/);
    if (!match) return;
    const musicaId = parseInt(match[1]);
    if (seen.has(musicaId)) return;
    seen.add(musicaId);

    const title = $(el).find(".info-letra p").first().text().trim() ||
                  $(el).find("p").first().text().trim();
    const artist = $(el).find(".info-letra .interprete").text().trim() ||
                   $(el).find(".interprete").text().trim();
    const img = $(el).find("img").attr("src") ||
                $(el).find("img").attr("data-src") || null;

    if (title) {
      songs.push({
        id: musicaId,
        musicaId,
        title,
        artistName: artist || "Artista Desconocido",
        albumCover: img || `https://i.musicaimg.com/letras/500/${musicaId}.jpg`,
        audioUrl: ytCache[musicaId] ? `yt:${ytCache[musicaId]}` : null,
        genre,
        duration: 210,
      });
    }
    if (songs.length >= limit) return false;
  });

  return songs;
}

async function getTopArtistIds(limit = 10) {
  const url = `${BASE_URL}/letras.asp?topmusica=musica`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const ids = [];
  const seen = new Set();
  $("a[href*='letras.asp?letras=']").each((_, el) => {
    const href = $(el).attr("href") || "";
    const m = href.match(/letras=(\d+)/);
    if (m) {
      const id = parseInt(m[1]);
      if (!seen.has(id)) { seen.add(id); ids.push(id); }
    }
    if (ids.length >= limit) return false;
  });
  return ids;
}

async function getArtistSongs(musicaId, limit = 8) {
  const url = `${BASE_URL}/letras.asp?letras=${musicaId}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  // Artist info
  let artistName = "";
  let artistImage = null;
  try {
    const ldRaw = $('script[type="application/ld+json"]').first().html() || "";
    if (ldRaw) {
      const ld = JSON.parse(ldRaw);
      artistName = ld.name || "";
      artistImage = ld.image?.url || null;
    }
  } catch {}
  if (!artistName) artistName = $(".perfil h1").first().text().replace(/^Letras de\s+/i, "").trim();
  if (!artistImage) artistImage = $(".perfil .poster img").first().attr("src") || null;

  const songs = [];
  $("ul.listado-letras li a").each((_, el) => {
    const href = $(el).attr("href") || "";
    const m = href.match(/letra=(\d+)/);
    if (!m) return;
    const id = parseInt(m[1]);
    let title = $(el).text().trim().replace(/^Letra\s+/i, "");
    if (title) {
      songs.push({
        id,
        musicaId: id,
        title,
        artistName,
        albumCover: `https://i.musicaimg.com/letras/500/${id}.jpg`,
        audioUrl: ytCache[id] ? `yt:${ytCache[id]}` : null,
        genre: "Pop",
        duration: 210,
      });
    }
    if (songs.length >= limit) return false;
  });

  return { artistName, artistImage, songs };
}

async function scrapeYouTubeId(musicaId) {
  if (ytCache[musicaId] !== undefined) return ytCache[musicaId];
  try {
    const url = `${BASE_URL}/letras.asp?letra=${musicaId}`;
    const html = await fetchHtml(url, 8000);
    const $ = cheerio.load(html);

    // Try JSON-LD
    let ytId = null;
    try {
      const ld = JSON.parse($('script[type="application/ld+json"]').first().html() || "{}");
      if (ld.url && ld.url.includes("youtube")) {
        const m = ld.url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
        if (m) ytId = m[1];
      }
    } catch {}

    // Try videoblogs link
    if (!ytId) {
      const vbLink = $("a[href*='videoblogs.com']").first().attr("href");
      if (vbLink) {
        try {
          const vbHtml = await fetchHtml(vbLink, 6000);
          const m = vbHtml.match(/videoId:\s*'([^']{6,15})'/);
          if (m) ytId = m[1];
        } catch {}
      }
    }

    ytCache[musicaId] = ytId;
    return ytId;
  } catch {
    ytCache[musicaId] = null;
    return null;
  }
}

// ─── Soundfly.es search ───────────────────────────────────────────────────────

function parseSoundflyBootstrap(html) {
  const patterns = [
    /window\.__INITIAL_STATE__\s*=\s*({[\s\S]+?});\s*<\/script>/,
    /bootstrapData\s*=\s*({[\s\S]+?});\s*<\/script>/,
    /window\.__data\s*=\s*({[\s\S]+?});\s*<\/script>/,
  ];
  for (const pat of patterns) {
    const m = html.match(pat);
    if (m) {
      try { return JSON.parse(m[1]); } catch {}
    }
  }
  return null;
}

async function searchSoundfly(query, limit = 15) {
  const slug = query.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const url = `${SOUNDFLY_BASE}/search/${encodeURIComponent(slug)}`;
  try {
    const html = await fetchHtml(url, 10000);
    const data = parseSoundflyBootstrap(html);
    if (!data) return [];

    const tracks =
      data?.loaders?.searchPage?.results?.tracks?.data ||
      data?.searchPage?.results?.tracks?.data ||
      [];

    return tracks.slice(0, limit).map((t) => ({
      id: t.id,
      musicaId: null,
      title: t.name,
      artistName: t.artists?.[0]?.name ?? "Artista Desconocido",
      albumCover: t.album?.image ?? t.image ?? null,
      audioUrl: t.youtube_id ? `yt:${t.youtube_id}` : null,
      genre: "Pop",
      duration: t.duration ? Math.round(t.duration / 1000) : 210,
      spotifyPopularity: t.spotify_popularity ?? 0,
    }));
  } catch {
    return [];
  }
}

async function searchMusicaCom(query, limit = 12) {
  const url = `${BASE_URL}/letras.asp?t2=${encodeURIComponent(query)}`;
  try {
    const html = await fetchHtml(url, 8000);
    const $ = cheerio.load(html);

    const songs = [];
    const seen = new Set();

    // song results
    $("a[href*='letra=']").each((_, el) => {
      const href = $(el).attr("href") || "";
      const m = href.match(/letra=(\d+)/);
      if (!m) return;
      const id = parseInt(m[1]);
      if (seen.has(id)) return;
      seen.add(id);
      const title = $(el).text().trim();
      if (!title) return;
      songs.push({
        id,
        musicaId: id,
        title,
        artistName: "Artista",
        albumCover: `https://i.musicaimg.com/letras/500/${id}.jpg`,
        audioUrl: ytCache[id] ? `yt:${ytCache[id]}` : null,
        genre: "Pop",
        duration: 210,
      });
      if (songs.length >= limit) return false;
    });

    return songs;
  } catch {
    return [];
  }
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// GET /api/songs?genre=pop&limit=20
app.get("/api/songs", async (req, res) => {
  const genre = req.query.genre || "pop";
  const limit = Math.min(parseInt(req.query.limit) || 20, 30);

  const cached = songCache[genre];
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.json({ songs: cached.songs.slice(0, limit), fromCache: true });
  }

  try {
    const songs = await getSongsFromPlaylist(genre, limit);
    songCache[genre] = { songs, ts: Date.now() };
    res.json({ songs, fromCache: false });
  } catch (err) {
    res.status(500).json({ error: err.message, songs: [] });
  }
});

// GET /api/trending — top artists' songs
app.get("/api/trending", async (req, res) => {
  const cached = songCache["__trending__"];
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.json({ songs: cached.songs, fromCache: true });
  }

  try {
    const [pop, reggaeton] = await Promise.all([
      getSongsFromPlaylist("pop", 10),
      getSongsFromPlaylist("reggaeton", 10),
    ]);
    const songs = [...pop, ...reggaeton].slice(0, 20);
    songCache["__trending__"] = { songs, ts: Date.now() };
    res.json({ songs, fromCache: false });
  } catch (err) {
    res.status(500).json({ error: err.message, songs: [] });
  }
});

// GET /api/search?q=query
app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q || q.length < 2) return res.json({ songs: [] });

  const key = q.toLowerCase();
  const cached = searchCache[key];
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.json({ songs: cached.songs, fromCache: true });
  }

  try {
    // Try soundfly first for richer metadata
    let songs = await searchSoundfly(q, 15);

    // Fall back to musica.com
    if (songs.length === 0) {
      songs = await searchMusicaCom(q, 15);
    }

    searchCache[key] = { songs, ts: Date.now() };
    res.json({ songs, fromCache: false });
  } catch (err) {
    res.status(500).json({ error: err.message, songs: [] });
  }
});

// GET /api/youtube/:musicaId — lazy-fetch YouTube ID
app.get("/api/youtube/:musicaId", async (req, res) => {
  const musicaId = parseInt(req.params.musicaId);
  if (isNaN(musicaId)) return res.status(400).json({ error: "Invalid id" });

  const ytId = await scrapeYouTubeId(musicaId);
  if (ytId) {
    res.json({ youtubeId: ytId, audioUrl: `yt:${ytId}` });
  } else {
    res.status(404).json({ youtubeId: null });
  }
});

// ─── HTML Frontend ────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Música Pro</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box;}
    :root{--primary:#a855f7;--primary-dark:#9333ea;--bg:#0a0a0f;--surface:#111118;--card:rgba(255,255,255,0.04);--border:rgba(255,255,255,0.08);--text:rgba(255,255,255,0.9);--muted:rgba(255,255,255,0.45);}

    body{font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--text);height:100vh;overflow:hidden;display:flex;flex-direction:column;}

    /* TOP NAV */
    nav{height:56px;display:flex;align-items:center;justify-content:space-between;padding:0 24px;background:rgba(10,10,15,0.9);backdrop-filter:blur(12px);border-bottom:1px solid var(--border);flex-shrink:0;z-index:50;}
    .logo{font-size:1.1rem;font-weight:800;letter-spacing:2px;background:linear-gradient(90deg,var(--primary),#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent;}
    .search-bar{display:flex;align-items:center;gap:8px;background:rgba(255,255,255,0.06);border:1px solid var(--border);border-radius:50px;padding:7px 16px;width:280px;transition:border-color .2s;}
    .search-bar:focus-within{border-color:var(--primary);}
    .search-bar input{background:none;border:none;outline:none;color:var(--text);font-size:.88rem;width:100%;}
    .search-bar input::placeholder{color:var(--muted);}
    .nav-genre{display:flex;gap:8px;}
    .genre-btn{background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:50px;padding:5px 14px;font-size:.78rem;cursor:pointer;transition:all .2s;}
    .genre-btn.active,.genre-btn:hover{border-color:var(--primary);color:var(--primary);background:rgba(168,85,247,.1);}

    /* LAYOUT */
    .main-layout{display:flex;flex:1;overflow:hidden;}

    /* SIDEBAR */
    aside{width:220px;flex-shrink:0;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow-y:auto;padding:16px 0;}
    .sidebar-sect{padding:0 12px;margin-bottom:8px;}
    .sidebar-sect h3{font-size:.65rem;letter-spacing:2px;text-transform:uppercase;color:var(--muted);padding:8px 8px 4px;}
    .sidebar-link{display:flex;align-items:center;gap:10px;padding:9px 8px;border-radius:8px;color:rgba(255,255,255,.65);font-size:.85rem;cursor:pointer;transition:all .2s;border:none;background:none;width:100%;}
    .sidebar-link:hover,.sidebar-link.active{background:rgba(255,255,255,.06);color:#fff;}
    .sidebar-link svg{opacity:.55;flex-shrink:0;}
    .sidebar-link.active svg{opacity:1;color:var(--primary);}
    .sidebar-divider{height:1px;background:var(--border);margin:8px 12px;}

    /* MAIN CONTENT */
    .content{flex:1;overflow-y:auto;padding:24px;}

    .section-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;}
    .section-header h2{font-size:1rem;font-weight:700;}
    .section-header a{font-size:.75rem;color:var(--muted);cursor:pointer;transition:color .2s;}
    .section-header a:hover{color:#fff;}

    /* SONG LIST */
    .song-list{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden;}
    .song-row{display:flex;align-items:center;gap:12px;padding:10px 14px;cursor:pointer;transition:background .15s;border-bottom:1px solid rgba(255,255,255,.04);}
    .song-row:last-child{border-bottom:none;}
    .song-row:hover{background:rgba(255,255,255,.05);}
    .song-row.active{background:rgba(168,85,247,.12);}
    .song-row .cover{width:42px;height:42px;border-radius:8px;object-fit:cover;background:var(--border);flex-shrink:0;}
    .song-row .cover-placeholder{width:42px;height:42px;border-radius:8px;background:linear-gradient(135deg,rgba(168,85,247,.3),rgba(236,72,153,.3));display:flex;align-items:center;justify-content:center;font-size:.75rem;color:var(--muted);flex-shrink:0;}
    .song-info{flex:1;min-width:0;}
    .song-title{font-size:.88rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .song-artist{font-size:.75rem;color:var(--muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .song-row.active .song-title{color:var(--primary);}
    .song-duration{font-size:.72rem;color:var(--muted);flex-shrink:0;}
    .eq-bars{display:flex;align-items:flex-end;gap:1.5px;height:14px;flex-shrink:0;}
    .eq-bars span{width:2.5px;border-radius:2px;background:var(--primary);animation:eq .7s ease-in-out infinite alternate;}
    .eq-bars span:nth-child(1){height:6px;animation-delay:0s;}
    .eq-bars span:nth-child(2){height:12px;animation-delay:.15s;}
    .eq-bars span:nth-child(3){height:8px;animation-delay:.3s;}
    @keyframes eq{0%{transform:scaleY(.4);}100%{transform:scaleY(1);}}

    /* CARDS */
    .cards-row{display:flex;gap:14px;overflow-x:auto;padding-bottom:8px;}
    .cards-row::-webkit-scrollbar{display:none;}
    .card{flex-shrink:0;width:140px;cursor:pointer;}
    .card:hover .card-cover{transform:scale(1.04);}
    .card-cover-wrap{width:140px;height:140px;border-radius:12px;overflow:hidden;background:var(--card);border:1px solid var(--border);margin-bottom:8px;}
    .card-cover{width:100%;height:100%;object-fit:cover;transition:transform .3s;}
    .card-cover-placeholder{width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:2.5rem;}
    .card-name{font-size:.82rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .card-sub{font-size:.72rem;color:var(--muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}

    /* SKELETON */
    .skeleton{background:linear-gradient(90deg,rgba(255,255,255,.04) 25%,rgba(255,255,255,.08) 50%,rgba(255,255,255,.04) 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:6px;}
    @keyframes shimmer{0%{background-position:200% 0;}100%{background-position:-200% 0;}}

    /* PLAYER BAR */
    .player-bar{height:72px;flex-shrink:0;background:rgba(15,15,20,0.97);border-top:1px solid var(--border);display:flex;align-items:center;padding:0 20px;gap:16px;backdrop-filter:blur(12px);}
    .player-cover{width:44px;height:44px;border-radius:8px;object-fit:cover;background:var(--border);flex-shrink:0;}
    .player-cover-placeholder{width:44px;height:44px;border-radius:8px;background:linear-gradient(135deg,var(--primary),#ec4899);display:flex;align-items:center;justify-content:center;font-size:1.3rem;flex-shrink:0;}
    .player-info{flex:0 0 200px;min-width:0;}
    .player-title{font-size:.85rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .player-artist{font-size:.72rem;color:var(--muted);margin-top:1px;}
    .player-controls{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;}
    .ctrl-btns{display:flex;align-items:center;gap:14px;}
    .ctrl-btn{background:none;border:none;color:rgba(255,255,255,.6);cursor:pointer;transition:color .2s;padding:4px;border-radius:50%;display:flex;align-items:center;justify-content:center;}
    .ctrl-btn:hover{color:#fff;}
    .ctrl-btn.play{width:38px;height:38px;border-radius:50%;background:var(--primary);color:#fff;box-shadow:0 4px 16px rgba(168,85,247,.4);}
    .ctrl-btn.play:hover{background:var(--primary-dark);}
    .progress-wrap{width:100%;display:flex;align-items:center;gap:8px;}
    .progress-time{font-size:.68rem;color:var(--muted);flex-shrink:0;width:32px;text-align:center;}
    .progress-track{flex:1;height:4px;background:rgba(255,255,255,.15);border-radius:4px;cursor:pointer;position:relative;}
    .progress-fill{height:100%;background:linear-gradient(90deg,var(--primary),#ec4899);border-radius:4px;pointer-events:none;transition:width .5s linear;}
    .volume-wrap{flex:0 0 120px;display:flex;align-items:center;gap:8px;}
    .volume-icon{color:var(--muted);cursor:pointer;}
    .volume-slider{flex:1;-webkit-appearance:none;height:3px;background:rgba(255,255,255,.2);border-radius:3px;outline:none;cursor:pointer;}
    .volume-slider::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;border-radius:50%;background:var(--primary);}

    /* LOADING / EMPTY */
    .loading-msg,.empty-msg{text-align:center;padding:48px 20px;color:var(--muted);font-size:.9rem;}
    .loading-msg .spinner{width:32px;height:32px;border:2px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 12px;}
    @keyframes spin{to{transform:rotate(360deg);}}

    /* YT hidden player */
    #yt-anchor{position:fixed;bottom:-1px;left:-1px;width:1px;height:1px;opacity:0;pointer-events:none;}

    /* TOAST */
    .toast{position:fixed;bottom:90px;left:50%;transform:translateX(-50%);background:rgba(40,40,50,.95);border:1px solid var(--border);border-radius:10px;padding:10px 20px;font-size:.82rem;color:#fff;z-index:999;opacity:0;transition:opacity .3s;pointer-events:none;}
    .toast.show{opacity:1;}

    @media(max-width:768px){
      aside{display:none;}
      .player-info{flex:0 0 130px;}
      .volume-wrap{display:none;}
      nav .nav-genre{display:none;}
      .search-bar{width:180px;}
    }
  </style>
</head>
<body>

<!-- Hidden YouTube anchor -->
<div id="yt-anchor"></div>
<div class="toast" id="toast"></div>

<!-- NAV -->
<nav>
  <div class="logo">♪ MÚSICA PRO</div>
  <div class="search-bar">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:rgba(255,255,255,.4)"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
    <input type="text" id="searchInput" placeholder="Buscar canciones, artistas...">
  </div>
  <div class="nav-genre">
    <button class="genre-btn active" data-genre="trending">Trending</button>
    <button class="genre-btn" data-genre="pop">Pop</button>
    <button class="genre-btn" data-genre="reggaeton">Reggaeton</button>
    <button class="genre-btn" data-genre="rock">Rock</button>
    <button class="genre-btn" data-genre="latina">Latina</button>
  </div>
</nav>

<!-- MAIN -->
<div class="main-layout">

  <!-- SIDEBAR -->
  <aside>
    <div class="sidebar-sect">
      <h3>Menú</h3>
      <button class="sidebar-link active">
        <svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
        Inicio
      </button>
      <button class="sidebar-link">
        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        Buscar
      </button>
    </div>
    <div class="sidebar-divider"></div>
    <div class="sidebar-sect">
      <h3>Géneros</h3>
      <button class="sidebar-link" data-genre="pop">🎵 Pop</button>
      <button class="sidebar-link" data-genre="reggaeton">🔥 Reggaeton</button>
      <button class="sidebar-link" data-genre="rock">🎸 Rock</button>
      <button class="sidebar-link" data-genre="latina">💃 Latina</button>
      <button class="sidebar-link" data-genre="hip-hop">🎤 Hip-Hop</button>
      <button class="sidebar-link" data-genre="electronica">⚡ Electrónica</button>
    </div>
  </aside>

  <!-- CONTENT -->
  <div class="content" id="content">
    <div class="loading-msg">
      <div class="spinner"></div>
      Cargando canciones reales...
    </div>
  </div>
</div>

<!-- PLAYER BAR -->
<div class="player-bar" id="playerBar" style="display:none">
  <div id="playerCover" class="player-cover-placeholder">🎵</div>
  <div class="player-info">
    <div class="player-title" id="playerTitle">—</div>
    <div class="player-artist" id="playerArtist">—</div>
  </div>
  <div class="player-controls">
    <div class="ctrl-btns">
      <button class="ctrl-btn" id="btnPrev" title="Anterior">
        <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24"><path d="M19 20L9 12l10-8v16zm-10 0H7V4h2v16z"/></svg>
      </button>
      <button class="ctrl-btn play" id="btnPlay">
        <svg id="iconPlay" width="18" height="18" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        <svg id="iconPause" width="18" height="18" fill="currentColor" viewBox="0 0 24 24" style="display:none"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
      </button>
      <button class="ctrl-btn" id="btnNext" title="Siguiente">
        <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24"><path d="M5 4l10 8-10 8V4zm10 0h2v16h-2V4z"/></svg>
      </button>
    </div>
    <div class="progress-wrap">
      <span class="progress-time" id="progCurrent">0:00</span>
      <div class="progress-track" id="progressTrack">
        <div class="progress-fill" id="progressFill" style="width:0%"></div>
      </div>
      <span class="progress-time" id="progDuration">0:00</span>
    </div>
  </div>
  <div class="volume-wrap">
    <svg class="volume-icon" width="16" height="16" fill="currentColor" viewBox="0 0 24 24" id="volIcon"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>
    <input type="range" class="volume-slider" id="volSlider" min="0" max="1" step="0.02" value="1">
  </div>
</div>

<script>
// ─── State ───────────────────────────────────────────────────────────────────
let allSongs = [];
let queue = [];
let queueIndex = -1;
let currentSong = null;
let isPlaying = false;
let duration = 0;
let progress = 0;
let ytPlayer = null;
let ytReady = false;
let progressInterval = null;
let currentGenre = "trending";
let searchTimeout = null;

// ─── YouTube IFrame API ──────────────────────────────────────────────────────
window.onYouTubeIframeAPIReady = function() {
  const anchor = document.getElementById("yt-anchor");
  ytPlayer = new YT.Player("yt-anchor", {
    height:"1", width:"1", videoId:"",
    playerVars:{autoplay:0,controls:0,disablekb:1,fs:0,rel:0,modestbranding:1},
    events:{
      onReady(){ ytReady = true; },
      onStateChange(e){
        if(e.data===1){ // playing
          try{ const d=ytPlayer.getDuration(); if(d) setDuration(d); }catch{}
          startProgress();
          isPlaying=true; updatePlayBtn();
        } else if(e.data===2){ // paused
          stopProgress(); isPlaying=false; updatePlayBtn();
        } else if(e.data===0){ // ended
          stopProgress(); nextSong();
        }
      },
      onError(){ stopProgress(); nextSong(); }
    }
  });
};

const ytScript = document.createElement("script");
ytScript.src = "https://www.youtube.com/iframe_api";
document.head.appendChild(ytScript);

// ─── Player functions ────────────────────────────────────────────────────────
function fmtTime(s){
  s=Math.floor(s||0);
  return Math.floor(s/60)+":"+(s%60<10?"0":"")+s%60;
}
function setDuration(d){
  duration=d;
  document.getElementById("progDuration").textContent=fmtTime(d);
}
function startProgress(){
  stopProgress();
  progressInterval=setInterval(()=>{
    if(!ytPlayer||!ytReady)return;
    try{
      const t=ytPlayer.getCurrentTime()||0;
      progress=t;
      document.getElementById("progCurrent").textContent=fmtTime(t);
      const pct=duration>0?(t/duration*100):0;
      document.getElementById("progressFill").style.width=pct+"%";
    }catch{}
  },500);
}
function stopProgress(){
  if(progressInterval){clearInterval(progressInterval);progressInterval=null;}
}
function updatePlayBtn(){
  document.getElementById("iconPlay").style.display=isPlaying?"none":"block";
  document.getElementById("iconPause").style.display=isPlaying?"block":"none";
}

async function playSong(song, newQueue){
  currentSong=song;
  if(newQueue){ queue=newQueue; queueIndex=newQueue.findIndex(s=>s.id===song.id); }
  isPlaying=true;
  updatePlayBtn();
  updatePlayerBar();
  highlightRow();
  document.getElementById("playerBar").style.display="flex";

  // If no YouTube ID, try to fetch it
  let ytId = getYtId(song.audioUrl);
  if(!ytId && song.musicaId){
    showToast("Buscando video...");
    try{
      const r=await fetch("/api/youtube/"+song.musicaId);
      if(r.ok){
        const d=await r.json();
        ytId=d.youtubeId;
        song.audioUrl="yt:"+ytId;
      }
    }catch{}
  }

  if(ytId){
    if(ytReady && ytPlayer){
      ytPlayer.loadVideoById(ytId);
    } else {
      const wait=()=>{
        if(ytReady&&ytPlayer){ ytPlayer.loadVideoById(ytId); }
        else setTimeout(wait,300);
      };
      setTimeout(wait,300);
    }
  } else {
    showToast("No hay audio disponible para esta canción");
    isPlaying=false;
    updatePlayBtn();
  }
}

function getYtId(audioUrl){
  if(!audioUrl) return null;
  if(audioUrl.startsWith("yt:")) return audioUrl.slice(3);
  return null;
}

function updatePlayerBar(){
  if(!currentSong)return;
  document.getElementById("playerTitle").textContent=currentSong.title;
  document.getElementById("playerArtist").textContent=currentSong.artistName;
  const cover=document.getElementById("playerCover");
  if(currentSong.albumCover){
    const img=new Image();
    img.onload=()=>{
      cover.outerHTML=\`<img id="playerCover" class="player-cover" src="\${currentSong.albumCover}" alt="">\`;
    };
    img.onerror=()=>{
      cover.outerHTML=\`<div id="playerCover" class="player-cover-placeholder">🎵</div>\`;
    };
    img.src=currentSong.albumCover;
  }
}

function highlightRow(){
  document.querySelectorAll(".song-row").forEach(r=>{
    const active=r.dataset.id==currentSong?.id;
    r.classList.toggle("active",active);
    const eq=r.querySelector(".eq-bars");
    if(eq)eq.style.display=active&&isPlaying?"flex":"none";
  });
}

function togglePlay(){
  if(!currentSong) return;
  if(!ytPlayer||!ytReady) return;
  try{
    if(isPlaying){ ytPlayer.pauseVideo(); }
    else { ytPlayer.playVideo(); }
    isPlaying=!isPlaying;
    updatePlayBtn();
    highlightRow();
  }catch{}
}

function nextSong(){
  if(queue.length===0)return;
  const ni=queueIndex+1<queue.length?queueIndex+1:0;
  queueIndex=ni;
  playSong(queue[ni], null);
}
function prevSong(){
  if(queue.length===0)return;
  const pi=queueIndex-1>=0?queueIndex-1:queue.length-1;
  queueIndex=pi;
  playSong(queue[pi], null);
}

// Progress click
document.getElementById("progressTrack").addEventListener("click",e=>{
  if(!duration||!ytPlayer||!ytReady)return;
  const rect=e.currentTarget.getBoundingClientRect();
  const pct=(e.clientX-rect.left)/rect.width;
  const t=pct*duration;
  try{ytPlayer.seekTo(t,true);}catch{}
  progress=t;
  document.getElementById("progCurrent").textContent=fmtTime(t);
  document.getElementById("progressFill").style.width=(pct*100)+"%";
});

// Volume
document.getElementById("volSlider").addEventListener("input",e=>{
  const v=parseFloat(e.target.value);
  if(ytPlayer&&ytReady){try{ytPlayer.setVolume(v*100);}catch{}}
});

document.getElementById("btnPlay").addEventListener("click",togglePlay);
document.getElementById("btnNext").addEventListener("click",nextSong);
document.getElementById("btnPrev").addEventListener("click",prevSong);

// ─── Render ───────────────────────────────────────────────────────────────────
function renderSongs(songs, title="Canciones"){
  const content=document.getElementById("content");
  if(!songs||songs.length===0){
    content.innerHTML=\`<div class="empty-msg">😕 No se encontraron canciones. Prueba otra búsqueda.</div>\`;
    return;
  }

  const rows=songs.map((s,i)=>\`
    <div class="song-row" data-id="\${s.id}" data-index="\${i}">
      \${s.albumCover
        ? \`<img class="cover" src="\${s.albumCover}" onerror="this.outerHTML='<div class=cover-placeholder>♪</div>'" loading="lazy">\`
        : \`<div class="cover-placeholder">♪</div>\`
      }
      <div class="song-info">
        <div class="song-title">\${escHtml(s.title)}</div>
        <div class="song-artist">\${escHtml(s.artistName)}</div>
      </div>
      <div class="eq-bars" style="display:none"><span></span><span></span><span></span></div>
      <div class="song-duration">\${fmtTime(s.duration||210)}</div>
    </div>
  \`).join("");

  content.innerHTML=\`
    <div class="section-header"><h2>\${escHtml(title)}</h2></div>
    <div class="song-list">\${rows}</div>
  \`;

  // Bind clicks
  content.querySelectorAll(".song-row").forEach(row=>{
    row.addEventListener("click",()=>{
      const idx=parseInt(row.dataset.index);
      playSong(songs[idx], songs);
    });
  });

  highlightRow();
}

function escHtml(str){
  return String(str||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function showToast(msg){
  const t=document.getElementById("toast");
  t.textContent=msg;
  t.classList.add("show");
  setTimeout(()=>t.classList.remove("show"),3000);
}

// ─── Load data ─────────────────────────────────────────────────────────────────
async function loadGenre(genre){
  currentGenre=genre;
  const content=document.getElementById("content");
  content.innerHTML=\`<div class="loading-msg"><div class="spinner"></div>Cargando canciones reales de \${genre}...</div>\`;

  const endpoint=genre==="trending"?"/api/trending":"/api/songs?genre="+genre+"&limit=25";
  try{
    const res=await fetch(endpoint);
    const data=await res.json();
    allSongs=data.songs||[];
    const labels={trending:"🔥 Tendencias",pop:"🎵 Pop",reggaeton:"🔥 Reggaeton",rock:"🎸 Rock",latina:"💃 Latina","hip-hop":"🎤 Hip-Hop",electronica:"⚡ Electrónica"};
    renderSongs(allSongs, labels[genre]||genre);
  }catch(err){
    content.innerHTML=\`<div class="empty-msg">❌ Error al cargar: \${err.message}</div>\`;
  }
}

async function doSearch(q){
  if(!q||q.length<2){loadGenre(currentGenre);return;}
  const content=document.getElementById("content");
  content.innerHTML=\`<div class="loading-msg"><div class="spinner"></div>Buscando en musica.com y soundfly.es...</div>\`;
  try{
    const res=await fetch("/api/search?q="+encodeURIComponent(q));
    const data=await res.json();
    renderSongs(data.songs||[], '🔍 Resultados para "'+q+'"');
  }catch(err){
    content.innerHTML=\`<div class="empty-msg">❌ Error: \${err.message}</div>\`;
  }
}

// ─── Event listeners ────────────────────────────────────────────────────────
document.querySelectorAll(".genre-btn").forEach(btn=>{
  btn.addEventListener("click",()=>{
    document.querySelectorAll(".genre-btn").forEach(b=>b.classList.remove("active"));
    btn.classList.add("active");
    loadGenre(btn.dataset.genre);
  });
});

document.querySelectorAll(".sidebar-link[data-genre]").forEach(btn=>{
  btn.addEventListener("click",()=>{
    document.querySelectorAll(".sidebar-link").forEach(b=>b.classList.remove("active"));
    btn.classList.add("active");
    loadGenre(btn.dataset.genre);
    // Sync nav genre btns
    document.querySelectorAll(".genre-btn").forEach(b=>{
      b.classList.toggle("active",b.dataset.genre===btn.dataset.genre);
    });
  });
});

document.getElementById("searchInput").addEventListener("input",e=>{
  clearTimeout(searchTimeout);
  const q=e.target.value.trim();
  searchTimeout=setTimeout(()=>doSearch(q),500);
});

// Initial load
loadGenre("trending");
</script>
</body>
</html>`;

app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(HTML);
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor corriendo en http://0.0.0.0:${PORT}`);
});
