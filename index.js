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

// ─── YouTube search by artist + title (no API key needed) ────────────────────
const ytSearchCache = {};  // "artist|title" → youtubeId

async function getYouTubeIdForSong(artist, title) {
  const key = `${artist}|${title}`.toLowerCase();
  if (ytSearchCache[key] !== undefined) return ytSearchCache[key];
  try {
    const q = `${artist} ${title} official audio`;
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
    const html = await fetchHtml(url, 10000);
    const matches = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/g);
    if (!matches || !matches.length) { ytSearchCache[key] = null; return null; }
    const ytId = matches[0].replace(/"videoId":"/, "").replace(/"$/, "");
    ytSearchCache[key] = ytId;
    return ytId;
  } catch {
    ytSearchCache[key] = null;
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

// GET /api/youtube/:musicaId — lazy-fetch YouTube ID via musica.com
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

// GET /api/youtube-search?artist=X&title=Y — find YouTube ID by song name
app.get("/api/youtube-search", async (req, res) => {
  const artist = (req.query.artist || "").trim();
  const title = (req.query.title || "").trim();
  if (!artist || !title) return res.status(400).json({ error: "artist and title required" });

  const ytId = await getYouTubeIdForSong(artist, title);
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
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"/>
  <title>SoundWave Pro</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
    :root{
      --p:#a855f7;--p2:#ec4899;--p3:#6366f1;
      --bg:#08080f;--bg2:#0e0e1a;--bg3:#13131f;
      --glass:rgba(255,255,255,0.045);
      --glass2:rgba(255,255,255,0.07);
      --border:rgba(255,255,255,0.07);
      --border2:rgba(255,255,255,0.12);
      --text:#f0f0f8;--muted:rgba(255,255,255,0.45);--muted2:rgba(255,255,255,0.28);
    }
    html,body{height:100%;overflow:hidden;}
    body{
      font-family:'Inter',system-ui,sans-serif;
      background:var(--bg);
      color:var(--text);
      display:flex;flex-direction:column;
      background-image:
        radial-gradient(ellipse 80% 50% at 20% -10%,rgba(168,85,247,.12) 0%,transparent 60%),
        radial-gradient(ellipse 60% 40% at 80% 110%,rgba(99,102,241,.1) 0%,transparent 60%);
    }

    /* ── SCROLLBAR ── */
    ::-webkit-scrollbar{width:4px;height:4px;}
    ::-webkit-scrollbar-track{background:transparent;}
    ::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:4px;}

    /* ── TOP BAR ── */
    .topbar{
      height:60px;flex-shrink:0;
      display:flex;align-items:center;justify-content:space-between;
      padding:0 20px;
      background:rgba(8,8,15,0.8);
      backdrop-filter:blur(24px);
      border-bottom:1px solid var(--border);
      z-index:100;
    }
    .logo{
      display:flex;align-items:center;gap:10px;
      font-weight:800;font-size:1rem;letter-spacing:.5px;
    }
    .logo-icon{
      width:32px;height:32px;border-radius:10px;
      background:linear-gradient(135deg,var(--p),var(--p2));
      display:flex;align-items:center;justify-content:center;
      font-size:.9rem;box-shadow:0 4px 16px rgba(168,85,247,.35);
      flex-shrink:0;
    }
    .logo-text{background:linear-gradient(90deg,#fff,rgba(255,255,255,.7));-webkit-background-clip:text;-webkit-text-fill-color:transparent;}

    .topbar-search{
      display:flex;align-items:center;gap:9px;
      background:var(--glass2);
      border:1px solid var(--border2);
      border-radius:50px;
      padding:9px 18px;
      width:320px;max-width:45vw;
      transition:border-color .2s,box-shadow .2s;
    }
    .topbar-search:focus-within{border-color:rgba(168,85,247,.6);box-shadow:0 0 0 3px rgba(168,85,247,.1);}
    .topbar-search input{background:none;border:none;outline:none;color:var(--text);font-size:.875rem;width:100%;font-family:inherit;}
    .topbar-search input::placeholder{color:var(--muted2);}

    .topbar-right{display:flex;align-items:center;gap:12px;}
    .avatar{
      width:34px;height:34px;border-radius:50%;
      background:linear-gradient(135deg,var(--p),var(--p3));
      display:flex;align-items:center;justify-content:center;
      font-size:.8rem;font-weight:700;cursor:pointer;
      border:2px solid rgba(168,85,247,.4);
    }

    /* ── LAYOUT ── */
    .app-body{display:flex;flex:1;overflow:hidden;}

    /* ── SIDEBAR (desktop) ── */
    .sidebar{
      width:230px;flex-shrink:0;
      background:rgba(10,10,20,0.6);
      border-right:1px solid var(--border);
      display:flex;flex-direction:column;
      overflow-y:auto;padding:20px 12px;
      gap:4px;
    }
    .sidebar-label{font-size:.65rem;letter-spacing:2.5px;text-transform:uppercase;color:var(--muted2);padding:16px 8px 6px;font-weight:600;}
    .sidebar-item{
      display:flex;align-items:center;gap:11px;
      padding:10px 10px;border-radius:10px;
      color:rgba(255,255,255,.6);font-size:.875rem;font-weight:500;
      cursor:pointer;border:none;background:none;width:100%;text-align:left;
      transition:all .18s;
    }
    .sidebar-item:hover{background:var(--glass2);color:#fff;}
    .sidebar-item.active{background:rgba(168,85,247,.14);color:var(--p);border:1px solid rgba(168,85,247,.2);}
    .sidebar-item svg{opacity:.7;flex-shrink:0;}
    .sidebar-item.active svg{opacity:1;}
    .sidebar-sep{height:1px;background:var(--border);margin:8px 0;}

    /* ── MAIN CONTENT ── */
    .main{flex:1;overflow-y:auto;padding:24px 24px 0;}

    /* chips */
    .chips{display:flex;gap:8px;flex-wrap:nowrap;overflow-x:auto;margin-bottom:28px;padding-bottom:2px;}
    .chips::-webkit-scrollbar{display:none;}
    .chip{
      flex-shrink:0;
      padding:7px 18px;border-radius:50px;
      font-size:.8rem;font-weight:600;cursor:pointer;
      border:1px solid var(--border2);
      background:var(--glass);
      color:var(--muted);
      transition:all .18s;
      white-space:nowrap;
    }
    .chip.active,.chip:hover{
      background:linear-gradient(135deg,rgba(168,85,247,.25),rgba(236,72,153,.15));
      border-color:rgba(168,85,247,.5);
      color:#fff;
      box-shadow:0 2px 12px rgba(168,85,247,.2);
    }

    /* ── SECTION HEADER ── */
    .sec{margin-bottom:28px;}
    .sec-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;}
    .sec-title{font-size:1.05rem;font-weight:700;letter-spacing:-.2px;}
    .sec-action{
      font-size:.78rem;font-weight:600;color:var(--muted);
      background:var(--glass);border:1px solid var(--border);
      border-radius:50px;padding:5px 14px;cursor:pointer;
      transition:all .18s;white-space:nowrap;
    }
    .sec-action:hover{color:#fff;border-color:var(--border2);}

    /* ── SONG ROWS (Selección rápida style) ── */
    .song-list{
      background:var(--glass);
      border:1px solid var(--border);
      border-radius:16px;
      overflow:hidden;
      backdrop-filter:blur(12px);
    }
    .song-row{
      display:flex;align-items:center;gap:13px;
      padding:12px 16px;cursor:pointer;
      transition:background .15s;
      border-bottom:1px solid rgba(255,255,255,.04);
      position:relative;
    }
    .song-row:last-child{border-bottom:none;}
    .song-row::before{
      content:'';position:absolute;left:0;top:0;bottom:0;width:3px;
      background:linear-gradient(180deg,var(--p),var(--p2));
      border-radius:0 3px 3px 0;opacity:0;transition:opacity .2s;
    }
    .song-row:hover{background:rgba(255,255,255,.04);}
    .song-row:hover::before{opacity:.5;}
    .song-row.active{background:rgba(168,85,247,.1);}
    .song-row.active::before{opacity:1;}

    .row-cover{
      width:48px;height:48px;border-radius:10px;
      object-fit:cover;flex-shrink:0;
      background:var(--bg3);
      box-shadow:0 4px 12px rgba(0,0,0,.4);
    }
    .row-cover-ph{
      width:48px;height:48px;border-radius:10px;flex-shrink:0;
      background:linear-gradient(135deg,rgba(168,85,247,.3),rgba(99,102,241,.3));
      display:flex;align-items:center;justify-content:center;
      font-size:.95rem;
    }
    .row-verify{color:rgba(168,85,247,.9);flex-shrink:0;}
    .row-info{flex:1;min-width:0;}
    .row-title{font-size:.9rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.1px;}
    .row-sub{font-size:.75rem;color:var(--muted);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .song-row.active .row-title{color:var(--p);}
    .row-right{display:flex;align-items:center;gap:10px;flex-shrink:0;}
    .row-dots{
      width:28px;height:28px;border-radius:50%;border:none;
      background:transparent;color:var(--muted2);
      display:flex;align-items:center;justify-content:center;
      cursor:pointer;transition:all .15s;font-size:1rem;
    }
    .row-dots:hover{background:var(--glass2);color:#fff;}
    .eq-bars{display:flex;align-items:flex-end;gap:2px;height:14px;}
    .eq-bars span{width:3px;border-radius:2px;background:var(--p);animation:eq .65s ease-in-out infinite alternate;}
    .eq-bars span:nth-child(1){height:5px;animation-delay:0s;}
    .eq-bars span:nth-child(2){height:12px;animation-delay:.12s;}
    .eq-bars span:nth-child(3){height:7px;animation-delay:.25s;}
    @keyframes eq{0%{transform:scaleY(.3);}100%{transform:scaleY(1);}}

    /* ── ALBUM GRID (Volver a escuchar) ── */
    .album-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;}
    .album-card{
      position:relative;border-radius:14px;overflow:hidden;
      aspect-ratio:1;cursor:pointer;
      background:var(--bg3);
      border:1px solid var(--border);
      transition:transform .22s,box-shadow .22s;
    }
    .album-card:hover{transform:scale(1.03);box-shadow:0 12px 32px rgba(0,0,0,.5);}
    .album-card img{width:100%;height:100%;object-fit:cover;display:block;}
    .album-card-ph{width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:2rem;background:linear-gradient(135deg,rgba(168,85,247,.2),rgba(99,102,241,.2));}
    .album-card-overlay{
      position:absolute;inset:0;
      background:linear-gradient(to top,rgba(0,0,0,.85) 0%,transparent 55%);
      display:flex;flex-direction:column;justify-content:flex-end;
      padding:10px;
    }
    .album-card-title{font-size:.78rem;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 4px rgba(0,0,0,.8);}
    .album-card-arrow{
      position:absolute;right:10px;bottom:10px;
      width:26px;height:26px;border-radius:50%;
      background:rgba(168,85,247,.85);
      display:flex;align-items:center;justify-content:center;
      font-size:.7rem;
    }

    /* ── HORIZONTAL SCROLL CARDS ── */
    .hscroll{display:flex;gap:14px;overflow-x:auto;padding-bottom:4px;}
    .hscroll::-webkit-scrollbar{display:none;}
    .hcard{flex-shrink:0;width:150px;cursor:pointer;}
    .hcard-img{
      width:150px;height:150px;border-radius:14px;overflow:hidden;
      background:var(--bg3);border:1px solid var(--border);
      margin-bottom:9px;
      box-shadow:0 8px 24px rgba(0,0,0,.35);
      transition:transform .22s;
    }
    .hcard:hover .hcard-img{transform:scale(1.04);}
    .hcard-img img{width:100%;height:100%;object-fit:cover;display:block;}
    .hcard-img-ph{width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:2.2rem;}
    .hcard-title{font-size:.82rem;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .hcard-sub{font-size:.72rem;color:var(--muted);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}

    /* ── MINI PLAYER ── */
    .mini-player{
      flex-shrink:0;
      background:rgba(12,12,22,0.92);
      backdrop-filter:blur(32px);
      border-top:1px solid var(--border2);
      padding:0;
    }
    .mini-player-bar{
      display:flex;align-items:center;gap:14px;
      padding:11px 20px 10px;
    }
    .mini-cover{
      width:46px;height:46px;border-radius:10px;object-fit:cover;
      flex-shrink:0;background:var(--bg3);
      box-shadow:0 4px 16px rgba(0,0,0,.5);
    }
    .mini-cover-ph{
      width:46px;height:46px;border-radius:10px;flex-shrink:0;
      background:linear-gradient(135deg,var(--p),var(--p2));
      display:flex;align-items:center;justify-content:center;font-size:1.2rem;
    }
    .mini-info{flex:1;min-width:0;}
    .mini-title{font-size:.875rem;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .mini-artist{font-size:.72rem;color:var(--muted);margin-top:2px;}
    .mini-controls{display:flex;align-items:center;gap:6px;flex-shrink:0;}
    .mctrl{
      width:36px;height:36px;border-radius:50%;border:none;
      background:transparent;color:rgba(255,255,255,.7);
      display:flex;align-items:center;justify-content:center;cursor:pointer;
      transition:all .18s;
    }
    .mctrl:hover{background:var(--glass2);color:#fff;}
    .mctrl.play-btn{
      width:40px;height:40px;
      background:linear-gradient(135deg,var(--p),var(--p2));
      color:#fff;
      box-shadow:0 4px 20px rgba(168,85,247,.5);
    }
    .mctrl.play-btn:hover{opacity:.9;transform:scale(1.06);}
    .mini-progress{height:3px;background:rgba(255,255,255,.1);cursor:pointer;position:relative;}
    .mini-progress-fill{height:100%;background:linear-gradient(90deg,var(--p),var(--p2));pointer-events:none;transition:width .5s linear;}

    /* ── BOTTOM NAV ── */
    .bottom-nav{
      flex-shrink:0;
      display:flex;align-items:center;justify-content:space-around;
      background:rgba(8,8,15,0.96);
      backdrop-filter:blur(24px);
      border-top:1px solid var(--border);
      padding:8px 4px calc(8px + env(safe-area-inset-bottom));
      height:calc(58px + env(safe-area-inset-bottom));
    }
    .nav-item{
      display:flex;flex-direction:column;align-items:center;gap:4px;
      padding:4px 12px;border-radius:12px;cursor:pointer;border:none;
      background:transparent;color:var(--muted);
      font-size:.65rem;font-weight:600;letter-spacing:.2px;
      transition:all .18s;min-width:52px;
    }
    .nav-item svg{transition:all .18s;}
    .nav-item.active{color:var(--p);}
    .nav-item.active svg{filter:drop-shadow(0 0 6px rgba(168,85,247,.7));}
    .nav-item:hover{color:rgba(255,255,255,.8);}

    /* ── LOADING / EMPTY ── */
    .loading-msg,.empty-msg{
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      padding:64px 20px;color:var(--muted);font-size:.9rem;gap:14px;
    }
    .spinner{
      width:36px;height:36px;
      border:2.5px solid rgba(168,85,247,.15);
      border-top-color:var(--p);
      border-radius:50%;animation:spin .75s linear infinite;
    }
    @keyframes spin{to{transform:rotate(360deg);}}

    /* ── TOAST ── */
    .toast{
      position:fixed;bottom:130px;left:50%;transform:translateX(-50%);
      background:rgba(20,20,35,.97);border:1px solid var(--border2);
      border-radius:50px;padding:10px 22px;font-size:.82rem;font-weight:500;
      color:#fff;z-index:999;opacity:0;transition:opacity .25s;pointer-events:none;
      backdrop-filter:blur(12px);white-space:nowrap;
      box-shadow:0 8px 32px rgba(0,0,0,.4);
    }
    .toast.show{opacity:1;}

    /* ── SEARCH VIEW ── */
    .search-view-input{
      display:flex;align-items:center;gap:10px;
      background:var(--glass2);border:1px solid var(--border2);
      border-radius:14px;padding:13px 18px;margin-bottom:20px;
      transition:border-color .2s;
    }
    .search-view-input:focus-within{border-color:rgba(168,85,247,.5);}
    .search-view-input input{background:none;border:none;outline:none;color:var(--text);font-size:1rem;width:100%;font-family:inherit;}
    .search-view-input input::placeholder{color:var(--muted2);}

    /* ── DESKTOP OVERRIDES ── */
    @media(min-width:768px){
      .bottom-nav{display:none;}
      .mini-player-bar{padding:12px 28px;}
      .mini-controls{gap:10px;}
      .mini-info{max-width:260px;}
      .vol-wrap{display:flex;align-items:center;gap:10px;flex-shrink:0;}
      .vol-slider{-webkit-appearance:none;width:90px;height:3px;background:rgba(255,255,255,.15);border-radius:3px;outline:none;cursor:pointer;}
      .vol-slider::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;border-radius:50%;background:var(--p);}
      .prog-times{display:flex;align-items:center;gap:8px;flex-shrink:0;}
      .prog-time{font-size:.7rem;color:var(--muted);width:34px;text-align:center;}
      .main{padding:28px 32px 0;}
      .album-grid{grid-template-columns:repeat(4,1fr);}
    }
    @media(max-width:767px){
      .sidebar{display:none;}
      .topbar-search{max-width:50vw;}
      .topbar-right .avatar{display:none;}
      .vol-wrap,.prog-times{display:none;}
      .album-grid{grid-template-columns:repeat(2,1fr);}
    }

    #yt-anchor{position:fixed;bottom:-2px;left:-2px;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;}
  </style>
</head>
<body>
<div id="yt-anchor"></div>
<div class="toast" id="toast"></div>

<!-- TOP BAR -->
<div class="topbar">
  <div class="logo">
    <div class="logo-icon">♪</div>
    <span class="logo-text">SoundWave</span>
  </div>
  <div class="topbar-search" id="topSearch" style="display:none">
    <svg width="15" height="15" fill="none" stroke="rgba(255,255,255,.4)" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
    <input type="text" id="searchInput" placeholder="Buscar canciones, artistas...">
  </div>
  <div class="topbar-right">
    <div class="avatar">U</div>
  </div>
</div>

<!-- APP BODY -->
<div class="app-body">

  <!-- SIDEBAR -->
  <nav class="sidebar" id="sidebar">
    <div class="sidebar-label">Principal</div>
    <button class="sidebar-item active" data-view="home">
      <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
      Inicio
    </button>
    <button class="sidebar-item" data-view="search">
      <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      Explorar
    </button>
    <button class="sidebar-item" data-view="library">
      <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
      Biblioteca
    </button>
    <div class="sidebar-sep"></div>
    <div class="sidebar-label">Géneros</div>
    <button class="sidebar-item" data-genre="pop">
      <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
      Pop
    </button>
    <button class="sidebar-item" data-genre="reggaeton">
      <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3z"/></svg>
      Reggaeton
    </button>
    <button class="sidebar-item" data-genre="rock">
      <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
      Rock
    </button>
    <button class="sidebar-item" data-genre="latina">
      <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
      Latina
    </button>
    <button class="sidebar-item" data-genre="hip-hop">
      <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/></svg>
      Hip-Hop
    </button>
    <button class="sidebar-item" data-genre="electronica">
      <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
      Electrónica
    </button>
  </nav>

  <!-- MAIN -->
  <div class="main" id="mainContent">
    <div class="loading-msg"><div class="spinner"></div>Cargando...</div>
  </div>
</div>

<!-- MINI PLAYER -->
<div class="mini-player" id="miniPlayer" style="display:none">
  <div class="mini-progress" id="miniProgress"><div class="mini-progress-fill" id="miniProgressFill" style="width:0%"></div></div>
  <div class="mini-player-bar">
    <div id="miniCover" class="mini-cover-ph">🎵</div>
    <div class="mini-info">
      <div class="mini-title" id="miniTitle">—</div>
      <div class="mini-artist" id="miniArtist">—</div>
    </div>
    <div class="prog-times" style="display:none">
      <span class="prog-time" id="progCurrent">0:00</span>
    </div>
    <div class="mini-controls">
      <button class="mctrl" id="btnPrev">
        <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24"><path d="M19 20L9 12l10-8v16zm-10 0H7V4h2v16z"/></svg>
      </button>
      <button class="mctrl play-btn" id="btnPlay">
        <svg id="iconPlay" width="18" height="18" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        <svg id="iconPause" width="18" height="18" fill="currentColor" viewBox="0 0 24 24" style="display:none"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
      </button>
      <button class="mctrl" id="btnNext">
        <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24"><path d="M5 4l10 8-10 8V4zm10 0h2v16h-2V4z"/></svg>
      </button>
    </div>
    <div class="vol-wrap" style="display:none">
      <svg width="15" height="15" fill="rgba(255,255,255,.5)" viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>
      <input type="range" class="vol-slider" id="volSlider" min="0" max="1" step="0.02" value="1">
    </div>
    <div class="prog-times" id="progTimesRight">
      <span class="prog-time" id="progDuration">0:00</span>
    </div>
  </div>
</div>

<!-- BOTTOM NAV (mobile) -->
<div class="bottom-nav">
  <button class="nav-item active" data-view="home">
    <svg width="22" height="22" fill="currentColor" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
    Principal
  </button>
  <button class="nav-item" data-view="search">
    <svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
    Explorar
  </button>
  <button class="nav-item" data-genre="trending">
    <svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
    Trending
  </button>
  <button class="nav-item" data-view="library">
    <svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
    Biblioteca
  </button>
</div>

<script>
// ─── State ────────────────────────────────────────────────────────────────────
let allSongs=[], queue=[], queueIndex=-1;
let currentSong=null, isPlaying=false, duration=0, progress=0;
let ytPlayer=null, ytReady=false, progressInterval=null;
let currentGenre="trending", currentView="home";
let searchTimeout=null;

// ─── YouTube IFrame API ───────────────────────────────────────────────────────
window.onYouTubeIframeAPIReady=()=>{
  ytPlayer=new YT.Player("yt-anchor",{
    height:"1",width:"1",videoId:"",
    playerVars:{autoplay:0,controls:0,disablekb:1,fs:0,rel:0,modestbranding:1},
    events:{
      onReady(){ ytReady=true; },
      onStateChange(e){
        if(e.data===1){
          try{const d=ytPlayer.getDuration();if(d)setDur(d);}catch{}
          startProg(); isPlaying=true; syncPlayBtn(); highlightRows();
        } else if(e.data===2){
          stopProg(); isPlaying=false; syncPlayBtn(); highlightRows();
        } else if(e.data===0){ stopProg(); nextSong(); }
      },
      onError(){ stopProg(); nextSong(); }
    }
  });
};
(()=>{const s=document.createElement("script");s.src="https://www.youtube.com/iframe_api";document.head.appendChild(s);})();

// ─── Player helpers ───────────────────────────────────────────────────────────
const fmt=s=>{s=Math.floor(s||0);return Math.floor(s/60)+":"+(s%60<10?"0":"")+s%60;};
function setDur(d){duration=d;document.getElementById("progDuration").textContent=fmt(d);}
function startProg(){
  stopProg();
  progressInterval=setInterval(()=>{
    if(!ytPlayer||!ytReady)return;
    try{
      const t=ytPlayer.getCurrentTime()||0; progress=t;
      document.getElementById("progCurrent").textContent=fmt(t);
      const pct=duration>0?(t/duration*100):0;
      document.getElementById("miniProgressFill").style.width=pct+"%";
    }catch{}
  },500);
}
function stopProg(){if(progressInterval){clearInterval(progressInterval);progressInterval=null;}}
function syncPlayBtn(){
  document.getElementById("iconPlay").style.display=isPlaying?"none":"block";
  document.getElementById("iconPause").style.display=isPlaying?"block":"none";
}
function highlightRows(){
  document.querySelectorAll(".song-row").forEach(r=>{
    const active=r.dataset.id==currentSong?.id;
    r.classList.toggle("active",active);
    const eq=r.querySelector(".eq-bars");
    if(eq)eq.style.display=active&&isPlaying?"flex":"none";
  });
}
function getYtId(url){return url?.startsWith("yt:")?url.slice(3):null;}

async function playSong(song,newQueue){
  currentSong=song;
  if(newQueue){queue=newQueue;queueIndex=newQueue.findIndex(s=>s.id===song.id);}
  isPlaying=true; syncPlayBtn(); updateMiniPlayer(); highlightRows();
  document.getElementById("miniPlayer").style.display="block";

  let ytId=getYtId(song.audioUrl);
  if(!ytId){
    showToast("Buscando en YouTube...");
    try{
      let r;
      if(song.musicaId){r=await fetch("/api/youtube/"+song.musicaId);}
      else{const p=new URLSearchParams({artist:song.artistName||"",title:song.title||""});r=await fetch("/api/youtube-search?"+p);}
      if(r?.ok){const d=await r.json();if(d.youtubeId){ytId=d.youtubeId;song.audioUrl="yt:"+ytId;}}
    }catch{}
  }
  if(ytId){
    const load=()=>{if(ytReady&&ytPlayer)ytPlayer.loadVideoById(ytId);else setTimeout(load,300);};
    load();
  } else {
    showToast("Audio no disponible en YouTube");
    isPlaying=false; syncPlayBtn(); highlightRows();
  }
}

function togglePlay(){
  if(!currentSong||!ytPlayer||!ytReady)return;
  try{isPlaying?ytPlayer.pauseVideo():ytPlayer.playVideo();}catch{}
}
function nextSong(){if(!queue.length)return;const ni=(queueIndex+1)%queue.length;queueIndex=ni;playSong(queue[ni],null);}
function prevSong(){if(!queue.length)return;if(progress>3){try{ytPlayer.seekTo(0,true);progress=0;}catch{}return;}const pi=queueIndex-1>=0?queueIndex-1:queue.length-1;queueIndex=pi;playSong(queue[pi],null);}

function updateMiniPlayer(){
  if(!currentSong)return;
  document.getElementById("miniTitle").textContent=currentSong.title;
  document.getElementById("miniArtist").textContent=currentSong.artistName;
  const el=document.getElementById("miniCover");
  if(currentSong.albumCover){
    const img=new Image();
    img.onload=()=>el.outerHTML=\`<img id="miniCover" class="mini-cover" src="\${currentSong.albumCover}" alt="">\`;
    img.onerror=()=>el.outerHTML=\`<div id="miniCover" class="mini-cover-ph">🎵</div>\`;
    img.src=currentSong.albumCover;
  }
}

// Progress click
document.getElementById("miniProgress").addEventListener("click",e=>{
  if(!duration||!ytPlayer||!ytReady)return;
  const r=e.currentTarget.getBoundingClientRect();
  const pct=(e.clientX-r.left)/r.width;
  const t=pct*duration;
  try{ytPlayer.seekTo(t,true);}catch{}
  progress=t;
  document.getElementById("miniProgressFill").style.width=(pct*100)+"%";
});
document.getElementById("volSlider").addEventListener("input",e=>{
  if(ytPlayer&&ytReady)try{ytPlayer.setVolume(parseFloat(e.target.value)*100);}catch{}
});
document.getElementById("btnPlay").addEventListener("click",togglePlay);
document.getElementById("btnNext").addEventListener("click",nextSong);
document.getElementById("btnPrev").addEventListener("click",prevSong);

// ─── HTML helpers ─────────────────────────────────────────────────────────────
const esc=s=>String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
function showToast(msg){const t=document.getElementById("toast");t.textContent=msg;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),3000);}
function fmtPlays(n){n=n||Math.floor(Math.random()*90+10)*1000000;if(n>=1e9)return(n/1e9).toFixed(1)+"B";if(n>=1e6)return Math.round(n/1e6)+" M";if(n>=1e3)return Math.round(n/1e3)+"K";return n;}

// ─── RENDER VIEWS ─────────────────────────────────────────────────────────────

function renderHome(songs, gridSongs){
  if(!songs||!songs.length){renderEmpty("No hay canciones disponibles");return;}

  const top=songs.slice(0,8);
  const grid=gridSongs||songs.slice(8,20);
  const horiz=songs.slice(0,10);

  const rowsHtml=top.map((s,i)=>\`
    <div class="song-row" data-id="\${s.id}" data-index="\${i}">
      \${s.albumCover
        ?\`<img class="row-cover" src="\${esc(s.albumCover)}" loading="lazy" onerror="this.outerHTML='<div class=row-cover-ph>♪</div>'">\`
        :\`<div class="row-cover-ph">♪</div>\`}
      <svg class="row-verify" width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
      <div class="row-info">
        <div class="row-title">\${esc(s.title)}</div>
        <div class="row-sub">\${esc(s.artistName)} · \${fmtPlays(s.plays)} reproducciones</div>
      </div>
      <div class="row-right">
        <div class="eq-bars" style="display:none"><span></span><span></span><span></span></div>
        <button class="row-dots" onclick="event.stopPropagation()">⋯</button>
      </div>
    </div>
  \`).join("");

  const gridHtml=grid.slice(0,6).map((s,i)=>\`
    <div class="album-card" data-index="\${top.length+i}">
      \${s.albumCover
        ?\`<img src="\${esc(s.albumCover)}" loading="lazy" onerror="this.style.display='none'">\`
        :\`<div class="album-card-ph">🎵</div>\`}
      <div class="album-card-overlay">
        <div class="album-card-title">\${esc(s.title)}</div>
      </div>
      <div class="album-card-arrow">▶</div>
    </div>
  \`).join("");

  const horizHtml=horiz.map((s,i)=>\`
    <div class="hcard" data-index="\${i}">
      <div class="hcard-img">
        \${s.albumCover
          ?\`<img src="\${esc(s.albumCover)}" loading="lazy" onerror="this.style.display='none'">\`
          :\`<div class="hcard-img-ph">🎵</div>\`}
      </div>
      <div class="hcard-title">\${esc(s.title)}</div>
      <div class="hcard-sub">\${esc(s.artistName)}</div>
    </div>
  \`).join("");

  const content=document.getElementById("mainContent");
  content.innerHTML=\`
    <div class="chips" id="genreChips">
      <div class="chip active" data-genre="trending">🔥 Trending</div>
      <div class="chip" data-genre="pop">Pop</div>
      <div class="chip" data-genre="reggaeton">Reggaeton</div>
      <div class="chip" data-genre="rock">Rock</div>
      <div class="chip" data-genre="latina">Latina</div>
      <div class="chip" data-genre="hip-hop">Hip-Hop</div>
      <div class="chip" data-genre="electronica">Electrónica</div>
    </div>
    <div class="sec">
      <div class="sec-hdr">
        <div class="sec-title">Selección rápida</div>
        <div class="sec-action">Reproducir todo</div>
      </div>
      <div class="song-list">\${rowsHtml}</div>
    </div>
    <div class="sec">
      <div class="sec-hdr"><div class="sec-title">Volver a escuchar</div></div>
      <div class="album-grid">\${gridHtml}</div>
    </div>
    <div class="sec" style="padding-bottom:24px">
      <div class="sec-hdr"><div class="sec-title">Novedades</div></div>
      <div class="hscroll">\${horizHtml}</div>
    </div>
  \`;

  // Bind rows
  content.querySelectorAll(".song-row").forEach(row=>{
    row.addEventListener("click",()=>{const i=parseInt(row.dataset.index);playSong(top[i],top);});
  });
  // Bind grid cards
  content.querySelectorAll(".album-card").forEach(card=>{
    card.addEventListener("click",()=>{const i=parseInt(card.dataset.index)-top.length;playSong(grid[i],grid);});
  });
  // Bind horizontal cards
  content.querySelectorAll(".hcard").forEach(card=>{
    card.addEventListener("click",()=>{const i=parseInt(card.dataset.index);playSong(horiz[i],horiz);});
  });
  // Bind chips
  content.querySelectorAll(".chip").forEach(chip=>{
    chip.addEventListener("click",()=>{loadGenre(chip.dataset.genre);});
  });
  // "Reproducir todo"
  content.querySelector(".sec-action").addEventListener("click",()=>{if(top.length)playSong(top[0],top);});

  highlightRows();
}

function renderSearch(){
  const content=document.getElementById("mainContent");
  content.innerHTML=\`
    <div class="search-view-input">
      <svg width="18" height="18" fill="none" stroke="rgba(255,255,255,.4)" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      <input type="text" id="searchViewInput" placeholder="Artistas, canciones, álbumes..." autofocus>
    </div>
    <div id="searchResults"><div class="empty-msg" style="padding:40px 0"><span>Busca tu música favorita</span></div></div>
  \`;
  const inp=content.querySelector("#searchViewInput");
  inp.addEventListener("input",e=>{
    clearTimeout(searchTimeout);
    const q=e.target.value.trim();
    searchTimeout=setTimeout(()=>doSearch(q),480);
  });
}

function renderResults(songs, query){
  const area=document.getElementById("searchResults");
  if(!songs||!songs.length){area.innerHTML=\`<div class="empty-msg">Sin resultados para "\${esc(query)}"</div>\`;return;}
  const rowsHtml=songs.map((s,i)=>\`
    <div class="song-row" data-id="\${s.id}" data-index="\${i}">
      \${s.albumCover
        ?\`<img class="row-cover" src="\${esc(s.albumCover)}" loading="lazy" onerror="this.outerHTML='<div class=row-cover-ph>♪</div>'">\`
        :\`<div class="row-cover-ph">♪</div>\`}
      <div class="row-info">
        <div class="row-title">\${esc(s.title)}</div>
        <div class="row-sub">\${esc(s.artistName)}</div>
      </div>
      <div class="row-right">
        <div class="eq-bars" style="display:none"><span></span><span></span><span></span></div>
        <button class="row-dots" onclick="event.stopPropagation()">⋯</button>
      </div>
    </div>
  \`).join("");
  area.innerHTML=\`<div class="sec-title" style="margin-bottom:12px">Resultados para "\${esc(query)}"</div><div class="song-list">\${rowsHtml}</div>\`;
  area.querySelectorAll(".song-row").forEach(row=>{
    row.addEventListener("click",()=>{const i=parseInt(row.dataset.index);playSong(songs[i],songs);});
  });
  highlightRows();
}

function renderEmpty(msg){
  document.getElementById("mainContent").innerHTML=\`<div class="empty-msg"><span>\${esc(msg)}</span></div>\`;
}
function renderLoading(msg="Cargando..."){
  document.getElementById("mainContent").innerHTML=\`<div class="loading-msg"><div class="spinner"></div>\${esc(msg)}</div>\`;
}

// ─── Data loading ─────────────────────────────────────────────────────────────
async function loadGenre(genre){
  currentGenre=genre;
  syncChips(genre);
  renderLoading("Cargando canciones reales...");
  const endpoint=genre==="trending"?"/api/trending":"/api/songs?genre="+genre+"&limit=25";
  try{
    const res=await fetch(endpoint);
    const data=await res.json();
    allSongs=data.songs||[];
    renderHome(allSongs);
  }catch(e){renderEmpty("Error al cargar: "+e.message);}
}

async function doSearch(q){
  if(!q||q.length<2){
    const area=document.getElementById("searchResults");
    if(area)area.innerHTML=\`<div class="empty-msg" style="padding:40px 0"><span>Busca tu música favorita</span></div>\`;
    return;
  }
  const area=document.getElementById("searchResults");
  if(area)area.innerHTML=\`<div class="loading-msg"><div class="spinner"></div>Buscando...</div>\`;
  try{
    const res=await fetch("/api/search?q="+encodeURIComponent(q));
    const data=await res.json();
    renderResults(data.songs||[],q);
  }catch(e){if(area)area.innerHTML=\`<div class="empty-msg">Error: \${esc(e.message)}</div>\`;}
}

function syncChips(genre){
  document.querySelectorAll(".chip").forEach(c=>c.classList.toggle("active",c.dataset.genre===genre));
}

// ─── Navigation ───────────────────────────────────────────────────────────────
function setView(view){
  currentView=view;
  // Sync sidebar
  document.querySelectorAll(".sidebar-item[data-view]").forEach(b=>b.classList.toggle("active",b.dataset.view===view));
  // Sync bottom nav
  document.querySelectorAll(".nav-item[data-view]").forEach(b=>b.classList.toggle("active",b.dataset.view===view));
  // Show/hide top search
  document.getElementById("topSearch").style.display=view==="search"?"flex":"none";

  if(view==="home"){ loadGenre(currentGenre); }
  else if(view==="search"){ renderSearch(); }
  else if(view==="library"){ renderEmpty("Tu biblioteca está vacía. ¡Reproduce canciones para empezar!"); }
}

// Nav item clicks (sidebar + bottom)
document.querySelectorAll(".sidebar-item[data-view], .nav-item[data-view]").forEach(btn=>{
  btn.addEventListener("click",()=>setView(btn.dataset.view));
});
document.querySelectorAll(".sidebar-item[data-genre], .nav-item[data-genre]").forEach(btn=>{
  btn.addEventListener("click",()=>{setView("home");setTimeout(()=>loadGenre(btn.dataset.genre),50);});
});

// Top search bar
document.getElementById("searchInput").addEventListener("input",e=>{
  clearTimeout(searchTimeout);
  const q=e.target.value.trim();
  searchTimeout=setTimeout(()=>doSearch(q),480);
});

// Desktop progress click
document.getElementById("miniProgress").addEventListener("click",e=>{
  if(!duration||!ytPlayer||!ytReady)return;
  const r=e.currentTarget.getBoundingClientRect();
  const pct=(e.clientX-r.left)/r.width;
  try{ytPlayer.seekTo(pct*duration,true);}catch{}
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
setView("home");
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
