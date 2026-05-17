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
  const ids = await getYouTubeIdsForSong(artist, title);
  return ids.length ? ids[0] : null;
}

async function getYouTubeIdsForSong(artist, title, limit = 25) {
  const key = `${artist}|${title}`.toLowerCase();
  if (ytSearchCache[key] !== undefined) return ytSearchCache[key];
  try {
    // Search with multiple queries — "topic" first finds YouTube Music auto-generated
    // channel videos (always embeddable), then fall back to audio/letra variants
    const queries = [
      `${artist} ${title} topic`,
      `${artist} ${title} audio`,
      `${artist} ${title} letra`,
      `${artist} ${title}`,
    ];
    const seen = new Set();
    const ids = [];
    for (const q of queries) {
      if (ids.length >= limit) break;
      try {
        const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
        const html = await fetchHtml(url, 10000);
        const matches = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/g) || [];
        for (const m of matches) {
          const id = m.replace(/"videoId":"/, "").replace(/"$/, "");
          if (!seen.has(id)) { seen.add(id); ids.push(id); }
          if (ids.length >= limit) break;
        }
      } catch {}
    }
    ytSearchCache[key] = ids;
    return ids;
  } catch {
    ytSearchCache[key] = [];
    return [];
  }
}

// Check if a YouTube video allows embedding via oEmbed
const embedCheckCache = {};
async function isEmbeddable(ytId) {
  if (embedCheckCache[ytId] !== undefined) return embedCheckCache[ytId];
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${ytId}&format=json`,
      { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(5000) }
    );
    embedCheckCache[ytId] = res.ok;
    return res.ok;
  } catch {
    embedCheckCache[ytId] = false;
    return false;
  }
}

async function getEmbeddableYouTubeIds(artist, title, maxResults = 5) {
  const allIds = await getYouTubeIdsForSong(artist, title);
  const embeddable = [];
  // Check in parallel (batches of 5)
  for (let i = 0; i < allIds.length && embeddable.length < maxResults; i += 5) {
    const batch = allIds.slice(i, i + 5);
    const checks = await Promise.all(batch.map(id => isEmbeddable(id)));
    for (let j = 0; j < batch.length; j++) {
      if (checks[j]) embeddable.push(batch[j]);
      if (embeddable.length >= maxResults) break;
    }
  }
  // Fallback: if none passed the check, return first few anyway
  return embeddable.length > 0 ? embeddable : allIds.slice(0, 3);
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

// GET /api/albums — random famous albums from Deezer chart
const albumsCache = { data: null, ts: 0 };
app.get("/api/albums", async (req, res) => {
  try {
    if (albumsCache.data && Date.now() - albumsCache.ts < 60 * 60 * 1000) {
      const shuffled = [...albumsCache.data].sort(() => Math.random() - 0.5);
      return res.json({ albums: shuffled.slice(0, 20) });
    }
    // Pull from multiple Deezer chart genres for variety
    const urls = [
      "https://api.deezer.com/chart/0/albums?limit=50",
      "https://api.deezer.com/chart/116/albums?limit=25",  // Latin
      "https://api.deezer.com/chart/132/albums?limit=25",  // Hip-hop
    ];
    const results = await Promise.allSettled(
      urls.map(u => fetch(u, { headers: { "User-Agent": USER_AGENT } }).then(r => r.json()))
    );
    const seen = new Set();
    const albums = [];
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      for (const a of (r.value.data || [])) {
        if (!a || !a.title || seen.has(a.id)) continue;
        seen.add(a.id);
        albums.push({
          id: a.id,
          title: a.title,
          artist: a.artist?.name || "",
          cover: a.cover_xl || a.cover_big || a.cover_medium || null,
          fans: a.fans || 0,
          releaseDate: a.release_date || "",
          tracksTotal: a.nb_tracks || 0,
        });
      }
    }
    albumsCache.data = albums;
    albumsCache.ts = Date.now();
    const shuffled = [...albums].sort(() => Math.random() - 0.5);
    res.json({ albums: shuffled.slice(0, 20) });
  } catch (err) {
    res.status(500).json({ error: err.message, albums: [] });
  }
});

// GET /api/album-tracks?id=X — fetch tracks for a Deezer album
app.get("/api/album-tracks", async (req, res) => {
  const id = parseInt(req.query.id);
  if (!id) return res.status(400).json({ error: "id required", tracks: [] });
  try {
    const r = await fetch(`https://api.deezer.com/album/${id}/tracks?limit=30`, {
      headers: { "User-Agent": USER_AGENT }
    });
    const data = await r.json();
    const albumR = await fetch(`https://api.deezer.com/album/${id}`, {
      headers: { "User-Agent": USER_AGENT }
    });
    const albumData = await albumR.json();
    const cover = albumData.cover_xl || albumData.cover_big || albumData.cover_medium || null;
    const tracks = (data.data || []).map((t, i) => ({
      id: `dz-alb-${t.id}`,
      musicaId: null,
      title: t.title,
      artistName: t.artist?.name || albumData.artist?.name || "",
      albumCover: cover,
      albumTitle: albumData.title || "",
      audioUrl: null,
      genre: "pop",
      duration: t.duration || 210,
      position: i + 1,
    }));
    res.json({ tracks, cover, title: albumData.title || "", artist: albumData.artist?.name || "" });
  } catch (err) {
    res.status(500).json({ error: err.message, tracks: [] });
  }
});

// GET /api/dice — truly random songs from a random genre
app.get("/api/dice", async (req, res) => {
  const ALL_DICE_GENRES = [
    "pop","reggaeton","rock","latina","hip-hop","trap","indie","electronica",
    "pop","reggaeton","latina","rock", // weighted so common genres appear more
  ];
  // Pick a random genre, different from the last one if possible
  const last = req.query.last || "";
  const pool = ALL_DICE_GENRES.filter(g => g !== last);
  const genre = pool[Math.floor(Math.random() * pool.length)];

  try {
    // Use cache when available for speed, otherwise fetch fresh
    const cached = songCache[genre];
    let songs = cached ? cached.songs : await getSongsFromPlaylist(genre, 25);
    if (!cached) songCache[genre] = { songs, ts: Date.now() };

    // Shuffle the list with a fresh seed every request
    const shuffled = [...songs].sort(() => Math.random() - 0.5);
    res.json({ songs: shuffled, genre });
  } catch (err) {
    res.status(500).json({ error: err.message, songs: [], genre });
  }
});

// GET /api/trending — real charts from all genres
app.get("/api/trending", async (req, res) => {
  const cached = songCache["__trending__"];
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.json({ songs: cached.songs, byGenre: cached.byGenre, fromCache: true });
  }
  try {
    const [pop, reggaeton, latina, hiphop, rock, electronica] = await Promise.all([
      getSongsFromPlaylist("pop", 10),
      getSongsFromPlaylist("reggaeton", 10),
      getSongsFromPlaylist("latina", 10),
      getSongsFromPlaylist("hip-hop", 10),
      getSongsFromPlaylist("rock", 10),
      getSongsFromPlaylist("electronica", 10),
    ]);
    const byGenre = { pop, reggaeton, latina, "hip-hop": hiphop, rock, electronica };
    // Interleave genres so top 10 is diverse
    const songs = [];
    const maxLen = Math.max(...Object.values(byGenre).map(a => a.length));
    for (let i = 0; i < maxLen; i++) {
      for (const g of Object.values(byGenre)) { if (g[i]) songs.push(g[i]); }
    }
    songCache["__trending__"] = { songs, byGenre, ts: Date.now() };
    res.json({ songs, byGenre, fromCache: false });
  } catch (err) {
    res.status(500).json({ error: err.message, songs: [], byGenre: {} });
  }
});

// GET /api/artist-photos?names=A,B,C — batch artist photos from Deezer
app.get("/api/artist-photos", async (req, res) => {
  const names = (req.query.names || "").split(",").map(n => n.trim()).filter(Boolean).slice(0, 14);
  if (!names.length) return res.json({ artists: [] });
  const results = await Promise.all(names.map(async name => {
    const info = await fetchArtistInfo(name);
    return info
      ? { name: info.name, id: info.id, image: info.image, fans: info.fans }
      : { name, id: null, image: null, fans: 0 };
  }));
  res.json({ artists: results });
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
    let songs = await searchSoundfly(q, 20);

    // Fall back to musica.com
    if (songs.length === 0) {
      songs = await searchMusicaCom(q, 20);
    }

    // ── Detect artist search via Deezer name matching ─────────────────────────
    let artist = null;
    const normalize = s => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const qNorm = normalize(q);

    // Ask Deezer if this query is a known artist
    const deezerArtist = await fetchArtistInfo(q);
    if (deezerArtist) {
      const aNorm = normalize(deezerArtist.name);
      const isMatch = aNorm === qNorm || aNorm.includes(qNorm) || qNorm.includes(aNorm);
      if (isMatch) {
        // Filter songs to only this artist
        const artistSongs = songs.filter(s => {
          const sNorm = normalize(s.artistName);
          return sNorm === aNorm || sNorm.includes(aNorm) || aNorm.includes(sNorm);
        });
        if (artistSongs.length >= 1) {
          artist = deezerArtist;
          songs = artistSongs;
        } else {
          // No songs matched — still show artist card with whatever we have
          artist = deezerArtist;
        }
      }
    }

    // Fallback: count-based detection if Deezer didn't match
    if (!artist && songs.length >= 3) {
      const counts = {};
      for (const s of songs) {
        const a = (s.artistName || "").toLowerCase().trim();
        if (a && a !== "artista desconocido" && a !== "artista") {
          counts[a] = (counts[a] || 0) + 1;
        }
      }
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      if (top && top[1] >= Math.ceil(songs.length * 0.5)) {
        const artistSongs = songs.filter(
          s => (s.artistName || "").toLowerCase().trim() === top[0]
        );
        const displayName = artistSongs[0].artistName;
        const info = await fetchArtistInfo(displayName);
        artist = info || { name: displayName, image: null, fans: 0 };
        songs = artistSongs;
      }
    }

    searchCache[key] = { songs, artist, ts: Date.now() };
    res.json({ songs, artist, fromCache: false });
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

// GET /api/artist-albums?id=X — albums for a Deezer artist
app.get("/api/artist-albums", async (req, res) => {
  const id = parseInt(req.query.id);
  if (!id) return res.status(400).json({ error: "id required", albums: [] });
  try {
    const r = await fetch(`https://api.deezer.com/artist/${id}/albums?limit=20`, {
      headers: { "User-Agent": USER_AGENT }
    });
    const data = await r.json();
    const albums = (data.data || []).map(a => ({
      id: a.id,
      title: a.title,
      artist: a.artist?.name || "",
      cover: a.cover_xl || a.cover_big || a.cover_medium || null,
      releaseDate: a.release_date || "",
      tracksTotal: a.nb_tracks || 0,
      recordType: a.record_type || "album",
    }));
    res.json({ albums });
  } catch (err) {
    res.status(500).json({ error: err.message, albums: [] });
  }
});

// GET /api/artist-profile?deezerId=X&name=Y — top tracks + artist info
const artistTopCache = {};
app.get("/api/artist-profile", async (req, res) => {
  const deezerId = req.query.deezerId;
  const name = (req.query.name || "").trim();
  if (!deezerId && !name) return res.status(400).json({ error: "deezerId or name required" });

  const cacheKey = deezerId || name.toLowerCase();
  if (artistTopCache[cacheKey]) return res.json(artistTopCache[cacheKey]);

  try {
    // Resolve deezer ID if not provided
    let id = deezerId;
    let artistInfo = null;
    if (!id && name) {
      artistInfo = await fetchArtistInfo(name);
      id = artistInfo?.id;
    } else {
      artistInfo = await fetchArtistInfo(name || "");
    }
    if (!id) return res.status(404).json({ error: "Artist not found" });

    const topRes = await fetch(`https://api.deezer.com/artist/${id}/top?limit=15`, {
      headers: { "User-Agent": USER_AGENT }
    });
    if (!topRes.ok) throw new Error("Deezer top tracks error");
    const topData = await topRes.json();
    const tracks = (topData.data || []).map((t, i) => ({
      id: `dz-${t.id}`,
      musicaId: null,
      title: t.title,
      artistName: t.artist?.name || name,
      albumCover: t.album?.cover_xl || t.album?.cover_big || t.album?.cover_medium || null,
      albumTitle: t.album?.title || "",
      audioUrl: null,
      genre: "Pop",
      duration: t.duration || 210,
      rank: t.rank || 0,
      position: i + 1
    }));

    const result = { artist: artistInfo, tracks };
    artistTopCache[cacheKey] = result;
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/youtube-search-multi?artist=X&title=Y — returns embeddable candidate IDs
app.get("/api/youtube-search-multi", async (req, res) => {
  const artist = (req.query.artist || "").trim();
  const title = (req.query.title || "").trim();
  if (!artist || !title) return res.status(400).json({ error: "artist and title required" });

  const ids = await getEmbeddableYouTubeIds(artist, title);
  res.json({ youtubeIds: ids });
});

// ─── Deezer artist info ───────────────────────────────────────────────────────
const artistInfoCache = {};
async function fetchArtistInfo(name) {
  const key = name.toLowerCase().trim();
  if (artistInfoCache[key] !== undefined) return artistInfoCache[key];
  try {
    const q = encodeURIComponent(name);
    const res = await fetch(`https://api.deezer.com/search/artist?q=${q}&limit=1`, {
      headers: { "User-Agent": USER_AGENT }
    });
    if (!res.ok) throw new Error("Deezer error");
    const data = await res.json();
    const a = data?.data?.[0];
    if (!a) { artistInfoCache[key] = null; return null; }
    const info = {
      id: a.id,
      name: a.name,
      image: a.picture_xl || a.picture_big || a.picture_medium || null,
      fans: a.nb_fan || 0
    };
    artistInfoCache[key] = info;
    return info;
  } catch {
    artistInfoCache[key] = null;
    return null;
  }
}

// GET /api/deezer-cover?artist=X&title=Y — high-res cover from Deezer
const deezerCoverCache = {};
app.get("/api/deezer-cover", async (req, res) => {
  const artist = (req.query.artist || "").trim();
  const title = (req.query.title || "").trim();
  if (!artist || !title) return res.status(400).json({ error: "artist and title required" });

  const key = `${artist}|${title}`.toLowerCase();
  if (deezerCoverCache[key]) return res.json(deezerCoverCache[key]);

  try {
    const q = encodeURIComponent(`${artist} ${title}`);
    const apiRes = await fetch(`https://api.deezer.com/search?q=${q}&limit=1`, {
      headers: { "User-Agent": USER_AGENT }
    });
    if (!apiRes.ok) throw new Error("Deezer error");
    const data = await apiRes.json();
    const track = data?.data?.[0];
    if (!track) { deezerCoverCache[key] = { cover: null }; return res.json({ cover: null }); }
    const result = {
      cover: track.album?.cover_xl || track.album?.cover_big || track.album?.cover_medium || null,
      cover_medium: track.album?.cover_medium || null,
    };
    deezerCoverCache[key] = result;
    res.json(result);
  } catch {
    res.json({ cover: null });
  }
});

// ─── HTML Frontend ────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"/>
  <title>PANCHO MIX</title>
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
      display:flex;align-items:center;gap:11px;
      font-weight:900;font-size:.95rem;letter-spacing:.12em;
      cursor:pointer;user-select:none;
    }
    .logo-icon{
      width:38px;height:38px;border-radius:12px;
      background:linear-gradient(145deg,#a855f7 0%,#6366f1 60%,#3b82f6 100%);
      display:flex;align-items:center;justify-content:center;
      box-shadow:0 0 0 1.5px rgba(168,85,247,.4),0 6px 24px rgba(99,102,241,.55);
      flex-shrink:0;position:relative;overflow:hidden;
      animation:logoGlow 3.5s ease-in-out infinite;
    }
    .logo-icon::after{
      content:'';position:absolute;inset:0;
      background:linear-gradient(135deg,rgba(255,255,255,.28) 0%,transparent 55%);
      border-radius:12px;
    }
    .logo-icon svg{position:relative;z-index:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,.3));}
    @keyframes logoGlow{
      0%,100%{box-shadow:0 0 0 1.5px rgba(168,85,247,.4),0 6px 24px rgba(99,102,241,.55);}
      50%{box-shadow:0 0 0 1.5px rgba(168,85,247,.65),0 8px 32px rgba(99,102,241,.85);}
    }
    .logo-text{
      background:linear-gradient(90deg,#fff 0%,#d8b4fe 40%,#fff 80%,#c4b5fd 100%);
      background-size:220% auto;
      -webkit-background-clip:text;-webkit-text-fill-color:transparent;
      background-clip:text;
      animation:logoShimmer 5s linear infinite;
    }
    @keyframes logoShimmer{to{background-position:220% center;}}
    .logo-badge{
      font-size:.45rem;font-weight:800;letter-spacing:.08em;
      background:linear-gradient(90deg,#a855f7,#6366f1);
      color:#fff;padding:2px 5px;border-radius:4px;
      margin-left:2px;align-self:flex-start;margin-top:2px;
      -webkit-text-fill-color:#fff;
    }



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

    /* ── PARA TI CAROUSEL ── */
    .pt-carousel{display:flex;gap:16px;overflow-x:auto;padding:0 0 12px;scrollbar-width:none;}
    .pt-carousel::-webkit-scrollbar{display:none;}
    .pt-card{
      flex-shrink:0;width:210px;border-radius:20px;overflow:hidden;cursor:pointer;
      position:relative;transition:transform .2s,box-shadow .2s;
      box-shadow:0 8px 32px rgba(0,0,0,.4);
    }
    .pt-card:hover{transform:translateY(-4px) scale(1.02);box-shadow:0 16px 48px rgba(0,0,0,.55);}
    .pt-card:active{transform:scale(.97);}
    .pt-card-bg{
      position:absolute;inset:0;
      background:var(--pt-grad,linear-gradient(135deg,#a855f7,#6366f1));
      z-index:0;
    }
    .pt-card-glass{
      position:absolute;inset:0;z-index:1;
      background:linear-gradient(160deg,rgba(255,255,255,.13) 0%,rgba(255,255,255,.04) 45%,rgba(0,0,0,.15) 100%);
      backdrop-filter:blur(0px);
    }
    .pt-card-shine{
      position:absolute;top:-60%;left:-30%;width:80%;height:120%;
      background:radial-gradient(ellipse,rgba(255,255,255,.18) 0%,transparent 70%);
      transform:rotate(-30deg);pointer-events:none;z-index:2;
    }
    .pt-cover-grid{
      position:relative;z-index:3;
      display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;
      width:100%;height:130px;overflow:hidden;
    }
    .pt-cover-grid img{width:100%;height:100%;object-fit:cover;}
    .pt-cover-icon{
      position:relative;z-index:3;
      width:100%;height:130px;display:flex;align-items:center;justify-content:center;
      font-size:4rem;
    }
    .pt-card-body{
      position:relative;z-index:3;
      padding:12px 14px 14px;
      background:linear-gradient(to bottom,rgba(0,0,0,.05),rgba(0,0,0,.35));
    }
    .pt-card-name{
      font-size:.92rem;font-weight:800;color:#fff;
      letter-spacing:-.015em;line-height:1.25;
      text-shadow:0 1px 8px rgba(0,0,0,.4);
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }
    .pt-card-desc{
      font-size:.72rem;color:rgba(255,255,255,.65);margin-top:4px;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }
    .pt-card-tag{
      display:inline-flex;align-items:center;gap:4px;
      margin-top:8px;padding:3px 10px;border-radius:50px;
      background:rgba(255,255,255,.15);backdrop-filter:blur(8px);
      font-size:.68rem;font-weight:700;color:#fff;letter-spacing:.03em;text-transform:uppercase;
    }

    /* ── NOVEDADES ALBUMS ── */
    .nov-scroll{display:flex;gap:14px;overflow-x:auto;padding:0 0 12px;scrollbar-width:none;}
    .nov-scroll::-webkit-scrollbar{display:none;}
    .nov-alb-card{
      flex-shrink:0;width:160px;cursor:pointer;
      transition:transform .2s;
    }
    .nov-alb-card:hover{transform:translateY(-4px);}
    .nov-alb-card:active{transform:scale(.95);}
    .nov-alb-cover{
      width:160px;height:160px;border-radius:14px;overflow:hidden;
      position:relative;flex-shrink:0;
      background:linear-gradient(135deg,rgba(168,85,247,.25),rgba(99,102,241,.25));
      box-shadow:0 6px 24px rgba(0,0,0,.45);margin-bottom:10px;
    }
    .nov-alb-cover img{width:100%;height:100%;object-fit:cover;display:block;}
    .nov-alb-cover-ph{
      position:absolute;inset:0;display:flex;align-items:center;
      justify-content:center;font-size:3.5rem;
    }
    .nov-alb-play{
      position:absolute;bottom:8px;right:8px;
      width:34px;height:34px;border-radius:50%;
      background:rgba(255,255,255,.92);
      display:flex;align-items:center;justify-content:center;
      opacity:0;transform:translateY(4px);
      transition:opacity .18s,transform .18s;
      box-shadow:0 4px 14px rgba(0,0,0,.4);
    }
    .nov-alb-card:hover .nov-alb-play{opacity:1;transform:translateY(0);}
    .nov-alb-name{
      font-size:.84rem;font-weight:700;color:#fff;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }
    .nov-alb-artist{
      font-size:.72rem;color:var(--muted);margin-top:2px;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }
    .nov-alb-meta{
      font-size:.66rem;color:rgba(255,255,255,.3);margin-top:2px;
    }
    .nov-alb-skel{
      flex-shrink:0;width:160px;
    }
    .nov-alb-skel-cover{
      width:160px;height:160px;border-radius:14px;margin-bottom:10px;
      background:linear-gradient(90deg,rgba(255,255,255,.04) 0%,rgba(255,255,255,.09) 50%,rgba(255,255,255,.04) 100%);
      background-size:200% 100%;
      animation:skelShimmer 1.4s infinite;
    }
    .nov-alb-skel-line{height:11px;border-radius:6px;margin-bottom:6px;
      background:rgba(255,255,255,.06);animation:skelShimmer 1.4s infinite;}
    .nov-alb-skel-line:last-child{width:65%;}
    @keyframes skelShimmer{
      0%{background-position:200% 0;}
      100%{background-position:-200% 0;}
    }

    /* ── DICE FAB ── */
    .dice-fab{
      position:fixed;
      bottom:calc(var(--player-h,80px) + 18px);
      right:18px;
      z-index:900;
      width:56px;height:56px;border-radius:18px;
      background:linear-gradient(145deg,#a855f7,#7c3aed);
      border:1.5px solid rgba(255,255,255,.22);
      display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;
      font-size:1.35rem;cursor:pointer;line-height:1;
      box-shadow:0 8px 32px rgba(168,85,247,.5),0 2px 8px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.18);
      transition:transform .18s,box-shadow .18s;
      user-select:none;
    }
    .dice-fab:hover{
      transform:translateY(-3px) scale(1.06);
      box-shadow:0 14px 44px rgba(168,85,247,.65),0 4px 12px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.18);
    }
    .dice-fab:active{transform:scale(.92);}
    .dice-fab-label{font-size:.48rem;font-weight:800;color:rgba(255,255,255,.75);letter-spacing:.08em;text-transform:uppercase;}
    .dice-fab.rolling{animation:diceRoll .45s cubic-bezier(.36,.07,.19,.97);}
    .dice-fab.loading{pointer-events:none;opacity:.8;}
    .dice-fab.loading .dice-emoji{animation:diceSpin .6s linear infinite;}
    @keyframes diceRoll{
      0%  {transform:rotate(0deg)   scale(1);}
      20% {transform:rotate(-15deg) scale(1.1);}
      50% {transform:rotate(200deg) scale(1.15);}
      80% {transform:rotate(340deg) scale(.95);}
      100%{transform:rotate(360deg) scale(1);}
    }
    @keyframes diceSpin{
      from{transform:rotate(0deg);}
      to{transform:rotate(360deg);}
    }

    /* ── SONG ROWS (Selección rápida style) ── */
    .song-list{
      background:var(--glass);
      border:1px solid var(--border);
      border-radius:16px;
      overflow:hidden;
      backdrop-filter:blur(12px);
    }
    /* ── Trending page ── */
    .trend-row{display:flex;align-items:center;gap:12px;padding:10px 16px;cursor:pointer;transition:background .15s;border-radius:12px;}
    .trend-row:active{background:rgba(255,255,255,.07);}
    .trend-rank{width:28px;text-align:center;font-size:1rem;font-weight:900;color:rgba(255,255,255,.3);flex-shrink:0;}
    .trend-rank-top{color:var(--p);}
    .trend-cover{width:50px;height:50px;border-radius:10px;overflow:hidden;flex-shrink:0;background:rgba(255,255,255,.08);position:relative;}
    .trend-cover img{width:100%;height:100%;object-fit:cover;}
    .trend-cover-ph{width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:1.4rem;}
    .trend-fire{position:absolute;top:-5px;right:-5px;font-size:.75rem;}
    .trend-info{flex:1;min-width:0;}
    .trend-title{font-size:.88rem;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .trend-artist{font-size:.72rem;color:rgba(255,255,255,.5);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .trend-badge{font-size:1rem;flex-shrink:0;width:22px;text-align:center;}
    .trend-page-hdr{padding:16px 20px 4px;}
    .trend-page-title{font-size:1.5rem;font-weight:900;letter-spacing:-.04em;}
    .trend-page-sub{font-size:.78rem;color:rgba(255,255,255,.4);margin-top:3px;}
    /* Trending artists row */
    .trend-artists-scroll{display:flex;gap:18px;overflow-x:auto;padding:4px 0 12px;scrollbar-width:none;}
    .trend-artists-scroll::-webkit-scrollbar{display:none;}
    .trend-artist-chip{display:flex;flex-direction:column;align-items:center;gap:7px;cursor:pointer;flex-shrink:0;width:70px;}
    .trend-artist-chip:active .tac-avatar{transform:scale(.93);}
    .tac-avatar{
      width:64px;height:64px;border-radius:50%;overflow:hidden;
      background:linear-gradient(135deg,var(--p),var(--p2));
      display:flex;align-items:center;justify-content:center;
      font-size:1.3rem;font-weight:800;color:#fff;
      border:2px solid rgba(255,255,255,.12);
      transition:transform .18s;flex-shrink:0;
      box-shadow:0 4px 14px rgba(0,0,0,.35);
    }
    .tac-avatar img{width:100%;height:100%;object-fit:cover;}
    .tac-name{font-size:.67rem;font-weight:600;text-align:center;width:100%;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
      color:rgba(255,255,255,.8);}
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
    .explore-top{padding:0 0 28px;}
    .search-bar-wrap{
      display:flex;align-items:center;gap:14px;
      background:rgba(255,255,255,.11);
      backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);
      border:1.5px solid rgba(255,255,255,.18);
      border-radius:50px;padding:15px 22px;
      transition:border-color .22s,box-shadow .22s,background .22s;
      box-shadow:0 4px 28px rgba(0,0,0,.28);
    }
    .search-bar-wrap:focus-within{
      border-color:rgba(168,85,247,.85);
      box-shadow:0 0 0 4px rgba(168,85,247,.2),0 6px 32px rgba(0,0,0,.35);
      background:rgba(168,85,247,.1);
    }
    .search-bar-wrap input{
      background:none;border:none;outline:none;
      color:#fff;font-size:1.08rem;width:100%;font-family:inherit;letter-spacing:.01em;
    }
    .search-bar-wrap input::placeholder{color:rgba(255,255,255,.42);}
    .search-clear-btn{
      background:rgba(255,255,255,.14);border:none;cursor:pointer;
      color:rgba(255,255,255,.75);font-size:.75rem;
      width:28px;height:28px;border-radius:50%;
      display:flex;align-items:center;justify-content:center;
      transition:background .2s,color .2s;flex-shrink:0;
    }
    .search-clear-btn:hover{background:rgba(168,85,247,.5);color:#fff;}
    .search-section-title{
      font-size:1.18rem;font-weight:700;
      color:#fff;margin-bottom:16px;letter-spacing:-.01em;
    }
    .search-recents-wrap{margin-bottom:30px;}
    .search-recent-list{display:flex;flex-direction:column;gap:2px;}
    .search-recent-item{
      display:flex;align-items:center;gap:14px;
      padding:11px 12px;border-radius:12px;cursor:pointer;
      transition:background .15s;color:rgba(255,255,255,.75);font-size:.9rem;
    }
    .search-recent-item:hover{background:rgba(255,255,255,.07);color:#fff;}
    .search-recent-icon{flex-shrink:0;opacity:.5;}
    .search-recent-del{
      margin-left:auto;background:none;border:none;cursor:pointer;
      color:rgba(255,255,255,.25);font-size:.75rem;padding:5px 6px;
      border-radius:50%;transition:background .15s,color .15s;
    }
    .search-recent-del:hover{background:rgba(255,255,255,.1);color:rgba(255,255,255,.8);}
    .genre-grid{
      display:grid;grid-template-columns:1fr 1fr;
      gap:12px;margin-bottom:40px;
    }
    .genre-card{
      position:relative;height:96px;border-radius:18px;overflow:hidden;
      cursor:pointer;transition:transform .18s,box-shadow .2s;
      box-shadow:0 6px 20px rgba(0,0,0,.35);
    }
    .genre-card:hover{transform:scale(1.035);box-shadow:0 10px 36px rgba(0,0,0,.5);}
    .genre-card:active{transform:scale(.96);}
    .genre-card-bg{position:absolute;inset:0;background:var(--gc);}
    .genre-card-shine{
      position:absolute;inset:0;
      background:linear-gradient(135deg,rgba(255,255,255,.18) 0%,rgba(255,255,255,0) 55%);
    }
    .genre-card-icon{
      position:absolute;right:-4px;bottom:-6px;
      font-size:3.8rem;opacity:.3;line-height:1;
      filter:drop-shadow(0 2px 8px rgba(0,0,0,.5));
      transform:rotate(-10deg);
    }
    .genre-card-label{
      position:absolute;top:0;left:0;bottom:0;right:0;
      display:flex;align-items:flex-end;
      padding:0 14px 13px;
      background:linear-gradient(to top,rgba(0,0,0,.42) 0%,transparent 60%);
    }
    .genre-card-label span{
      font-size:.95rem;font-weight:700;color:#fff;
      text-shadow:0 1px 8px rgba(0,0,0,.7);letter-spacing:.01em;
    }
    .search-results-header{
      display:flex;align-items:center;justify-content:space-between;
      margin-bottom:14px;
    }
    .search-results-count{font-size:.78rem;color:var(--muted);font-weight:500;letter-spacing:.01em;}
    .sr-hero{
      display:flex;align-items:flex-start;gap:16px;
      background:rgba(255,255,255,.08);
      backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);
      border:1px solid rgba(255,255,255,.13);
      border-radius:22px;padding:18px;margin-bottom:22px;cursor:pointer;
      transition:background .18s,box-shadow .18s;
      box-shadow:0 6px 28px rgba(0,0,0,.32);
    }
    .sr-hero:hover{background:rgba(255,255,255,.13);box-shadow:0 10px 40px rgba(0,0,0,.48);}
    .sr-hero-cover{
      width:78px;height:78px;border-radius:14px;object-fit:cover;
      flex-shrink:0;box-shadow:0 4px 20px rgba(0,0,0,.5);
    }
    .sr-hero-cover-ph{
      width:78px;height:78px;border-radius:14px;flex-shrink:0;
      background:linear-gradient(135deg,rgba(168,85,247,.4),rgba(99,102,241,.4));
      display:flex;align-items:center;justify-content:center;font-size:2rem;
    }
    .sr-hero-info{flex:1;min-width:0;}
    .sr-hero-tag{
      font-size:.62rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;
      color:rgba(168,85,247,.95);margin-bottom:6px;
    }
    .sr-hero-title{
      font-size:1.12rem;font-weight:700;color:#fff;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:4px;
    }
    .sr-hero-meta{font-size:.8rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .sr-hero-btns{display:flex;gap:8px;margin-top:13px;flex-wrap:nowrap;width:100%;}
    .sr-hero-play{
      display:flex;align-items:center;justify-content:center;gap:7px;
      background:#fff;color:#000;border:none;border-radius:50px;
      padding:10px 0;font-size:.84rem;font-weight:700;cursor:pointer;
      flex:1;
      transition:background .15s,transform .12s,box-shadow .15s;
      box-shadow:0 2px 14px rgba(0,0,0,.35);
    }
    .sr-hero-play:hover{background:#ececec;transform:scale(1.04);box-shadow:0 4px 20px rgba(0,0,0,.4);}
    .sr-hero-more{
      display:flex;align-items:center;justify-content:center;gap:5px;
      background:rgba(255,255,255,.1);
      backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
      border:1px solid rgba(255,255,255,.18);border-radius:50px;
      padding:10px 0;font-size:.84rem;color:rgba(255,255,255,.8);cursor:pointer;
      flex:1;
      transition:background .15s,color .15s;
    }
    .sr-hero-more:hover{background:rgba(255,255,255,.18);color:#fff;}
    .sr-list-label{
      font-size:.68rem;font-weight:700;letter-spacing:.13em;text-transform:uppercase;
      color:rgba(255,255,255,.28);margin-bottom:6px;padding-left:10px;
    }
    /* artist search: albums + playlists */
    .sr-sec{margin:22px 0 6px;}
    .sr-sec-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;}
    .sr-sec-title{font-size:.75rem;font-weight:700;letter-spacing:.11em;text-transform:uppercase;color:rgba(255,255,255,.3);}
    .sr-alb-scroll{display:flex;gap:13px;overflow-x:auto;padding-bottom:6px;scrollbar-width:none;}
    .sr-alb-scroll::-webkit-scrollbar{display:none;}
    .sr-alb-card{flex-shrink:0;width:130px;cursor:pointer;transition:transform .18s;}
    .sr-alb-card:hover{transform:translateY(-3px);}
    .sr-alb-card:active{transform:scale(.95);}
    .sr-alb-cover{
      width:130px;height:130px;border-radius:12px;overflow:hidden;position:relative;
      background:rgba(255,255,255,.06);box-shadow:0 4px 18px rgba(0,0,0,.4);margin-bottom:8px;
    }
    .sr-alb-cover img{width:100%;height:100%;object-fit:cover;display:block;}
    .sr-alb-cover-ph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:3rem;}
    .sr-alb-type{
      position:absolute;bottom:6px;left:6px;
      font-size:.58rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase;
      background:rgba(0,0,0,.55);backdrop-filter:blur(6px);
      color:rgba(255,255,255,.7);padding:2px 7px;border-radius:50px;
    }
    .sr-alb-title{font-size:.8rem;font-weight:700;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .sr-alb-year{font-size:.68rem;color:var(--muted);margin-top:2px;}
    .sr-alb-skel{flex-shrink:0;width:130px;}
    .sr-alb-skel-cover{width:130px;height:130px;border-radius:12px;margin-bottom:8px;
      background:rgba(255,255,255,.06);animation:skelShimmer 1.4s infinite;background-size:200% 100%;}
    .sr-alb-skel-line{height:10px;border-radius:5px;background:rgba(255,255,255,.05);
      animation:skelShimmer 1.4s infinite;background-size:200% 100%;margin-bottom:5px;}
    /* sr playlists */
    .sr-pl-scroll{display:flex;gap:13px;overflow-x:auto;padding-bottom:6px;scrollbar-width:none;}
    .sr-pl-scroll::-webkit-scrollbar{display:none;}
    .sr-pl-card{flex-shrink:0;width:130px;cursor:pointer;transition:transform .18s;}
    .sr-pl-card:hover{transform:translateY(-3px);}
    .sr-pl-card:active{transform:scale(.95);}
    .sr-pl-cover{
      width:130px;height:130px;border-radius:12px;overflow:hidden;position:relative;
      box-shadow:0 4px 18px rgba(0,0,0,.4);margin-bottom:8px;
    }
    .sr-pl-cover-grid{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;width:100%;height:100%;}
    .sr-pl-cover-grid img{width:100%;height:100%;object-fit:cover;}
    .sr-pl-cover-icon{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:3rem;}
    .sr-pl-name{font-size:.8rem;font-weight:700;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .sr-pl-desc{font-size:.68rem;color:var(--muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .search-result-row{
      display:flex;align-items:center;gap:14px;
      padding:9px 10px;border-radius:14px;cursor:pointer;
      transition:background .15s;margin-bottom:2px;
    }
    .search-result-row:hover,.search-result-row.active-row{
      background:rgba(255,255,255,.07);
      backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
    }
    .search-result-cover{
      width:52px;height:52px;border-radius:10px;object-fit:cover;
      flex-shrink:0;background:rgba(255,255,255,.08);
      box-shadow:0 2px 10px rgba(0,0,0,.3);
    }
    .search-result-cover-ph{
      width:52px;height:52px;border-radius:10px;flex-shrink:0;
      background:linear-gradient(135deg,rgba(168,85,247,.25),rgba(99,102,241,.25));
      display:flex;align-items:center;justify-content:center;font-size:1.3rem;
    }
    .search-result-info{flex:1;min-width:0;}
    .search-result-title{font-size:.92rem;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .search-result-meta{font-size:.76rem;color:var(--muted);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .search-result-actions{display:flex;align-items:center;flex-shrink:0;}
    .search-result-dots{
      background:none;border:none;cursor:pointer;color:rgba(255,255,255,.32);
      font-size:1.35rem;padding:6px 8px;transition:color .15s,background .15s;
      border-radius:8px;line-height:1;
    }
    .search-result-dots:hover{color:#fff;background:rgba(255,255,255,.07);}
    .search-empty-state{text-align:center;padding:70px 20px;}
    .search-empty-icon{font-size:3.2rem;margin-bottom:14px;opacity:.45;}
    .search-empty-text{color:var(--muted);font-size:.95rem;line-height:1.6;}
    .artist-card{
      display:flex;flex-direction:column;align-items:center;
      background:rgba(255,255,255,.06);
      backdrop-filter:blur(28px);-webkit-backdrop-filter:blur(28px);
      border:1px solid rgba(255,255,255,.1);
      border-radius:24px;padding:28px 20px 22px;margin-bottom:24px;
      text-align:center;cursor:pointer;transition:background .18s;
    }
    .artist-card:hover{background:rgba(255,255,255,.1);}
    .artist-avatar{
      width:96px;height:96px;border-radius:50%;object-fit:cover;
      flex-shrink:0;margin-bottom:14px;
      box-shadow:0 6px 32px rgba(0,0,0,.55);
      border:3px solid rgba(255,255,255,.12);
    }
    .artist-avatar-ph{
      width:96px;height:96px;border-radius:50%;flex-shrink:0;margin-bottom:14px;
      background:linear-gradient(135deg,rgba(168,85,247,.55),rgba(99,102,241,.55));
      display:flex;align-items:center;justify-content:center;
      font-size:2.4rem;font-weight:700;color:#fff;
      box-shadow:0 6px 32px rgba(0,0,0,.45);
      border:3px solid rgba(255,255,255,.12);
    }
    .artist-name{font-size:1.38rem;font-weight:800;color:#fff;margin-bottom:5px;letter-spacing:-.01em;}
    .artist-fans{font-size:.78rem;color:var(--muted);margin-bottom:18px;font-weight:500;}
    .artist-btns{display:flex;gap:10px;width:100%;max-width:320px;}
    .artist-btn-shuffle{
      display:flex;align-items:center;justify-content:center;gap:7px;
      background:#fff;color:#000;border:none;border-radius:50px;
      padding:11px 0;font-size:.86rem;font-weight:700;cursor:pointer;flex:1;
      transition:background .15s,transform .12s;box-shadow:0 2px 14px rgba(0,0,0,.35);
    }
    .artist-btn-shuffle:hover{background:#e8e8e8;transform:scale(1.03);}
    .artist-btn-radio{
      display:flex;align-items:center;justify-content:center;gap:7px;
      background:rgba(255,255,255,.12);
      backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
      border:1px solid rgba(255,255,255,.18);border-radius:50px;
      padding:11px 0;font-size:.86rem;font-weight:700;color:rgba(255,255,255,.9);
      cursor:pointer;flex:1;transition:background .15s;
    }
    .artist-btn-radio:hover{background:rgba(255,255,255,.2);}

    /* ── ARTIST PROFILE PAGE ── */
    .artist-profile{position:relative;min-height:100%;}
    .artist-hero{
      position:relative;width:100%;height:280px;
      overflow:hidden;flex-shrink:0;
    }
    .artist-hero-bg{
      position:absolute;inset:0;width:100%;height:100%;
      object-fit:cover;object-position:center top;
      filter:brightness(.75);
    }
    .artist-hero-bg-ph{
      position:absolute;inset:0;
      background:linear-gradient(135deg,rgba(168,85,247,.6),rgba(99,102,241,.4),rgba(8,8,15,1));
    }
    .artist-hero-gradient{
      position:absolute;inset:0;
      background:linear-gradient(to bottom,rgba(0,0,0,.18) 0%,rgba(8,8,15,.0) 40%,rgba(8,8,15,.92) 85%,var(--bg) 100%);
    }
    .artist-hero-back{
      position:absolute;top:16px;left:16px;z-index:10;
      width:36px;height:36px;border-radius:50%;
      background:rgba(0,0,0,.45);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
      border:none;display:flex;align-items:center;justify-content:center;
      cursor:pointer;color:#fff;transition:background .15s;
    }
    .artist-hero-back:hover{background:rgba(0,0,0,.65);}
    .artist-hero-info{
      position:absolute;bottom:18px;left:18px;right:18px;z-index:5;
    }
    .artist-hero-name{
      font-size:2rem;font-weight:900;color:#fff;
      letter-spacing:-.02em;line-height:1.1;
      text-shadow:0 2px 16px rgba(0,0,0,.6);
    }
    .artist-hero-fans{
      font-size:.8rem;color:rgba(255,255,255,.75);margin-top:5px;font-weight:500;
    }
    .artist-profile-actions{
      display:flex;align-items:center;gap:12px;
      padding:16px 18px 8px;
    }
    .ap-btn-follow{
      background:transparent;border:1.5px solid rgba(255,255,255,.5);
      border-radius:50px;padding:8px 22px;font-size:.84rem;font-weight:700;
      color:#fff;cursor:pointer;transition:border-color .15s,color .15s;
      flex-shrink:0;
    }
    .ap-btn-follow:hover{border-color:#fff;}
    .ap-btn-more{
      background:none;border:none;color:rgba(255,255,255,.55);
      font-size:1.3rem;cursor:pointer;padding:6px;flex-shrink:0;
      transition:color .15s;
    }
    .ap-btn-more:hover{color:#fff;}
    .ap-spacer{flex:1;}
    .ap-btn-shuffle{
      background:none;border:none;color:rgba(255,255,255,.6);cursor:pointer;
      padding:6px;transition:color .15s;flex-shrink:0;
    }
    .ap-btn-shuffle:hover{color:#fff;}
    .ap-btn-play{
      width:52px;height:52px;border-radius:50%;
      background:#fff;border:none;
      display:flex;align-items:center;justify-content:center;
      cursor:pointer;flex-shrink:0;
      transition:background .15s,transform .12s;
      box-shadow:0 4px 20px rgba(0,0,0,.4);
    }
    .ap-btn-play:hover{background:#e8e8e8;transform:scale(1.05);}
    .artist-profile-tabs{
      display:flex;gap:0;padding:0 18px;margin-bottom:4px;
      border-bottom:1px solid rgba(255,255,255,.08);
    }
    .ap-tab{
      font-size:.9rem;font-weight:600;color:var(--muted);
      padding:10px 14px;cursor:pointer;border-bottom:2.5px solid transparent;
      transition:color .15s,border-color .15s;margin-bottom:-1px;
    }
    .ap-tab.active{color:#fff;border-bottom-color:#fff;}
    .artist-popular-label{
      font-size:1.1rem;font-weight:800;color:#fff;
      padding:16px 18px 10px;letter-spacing:-.01em;
    }
    .ap-track-row{
      display:flex;align-items:center;gap:14px;
      padding:8px 18px;cursor:pointer;transition:background .15s;border-radius:10px;
    }
    .ap-track-row:hover{background:rgba(255,255,255,.07);}
    .ap-track-num{
      width:20px;text-align:right;font-size:.9rem;color:var(--muted);
      font-weight:500;flex-shrink:0;
    }
    .ap-track-cover{
      width:50px;height:50px;border-radius:8px;object-fit:cover;
      flex-shrink:0;box-shadow:0 2px 10px rgba(0,0,0,.3);
    }
    .ap-track-cover-ph{
      width:50px;height:50px;border-radius:8px;flex-shrink:0;
      background:linear-gradient(135deg,rgba(168,85,247,.3),rgba(99,102,241,.3));
      display:flex;align-items:center;justify-content:center;font-size:1.3rem;
    }
    .ap-track-info{flex:1;min-width:0;}
    .ap-track-title{
      font-size:.93rem;font-weight:600;color:#fff;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }
    .ap-track-title.playing{color:var(--p);}
    .ap-track-sub{
      font-size:.74rem;color:var(--muted);margin-top:2px;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }
    .ap-track-dots{
      background:none;border:none;color:rgba(255,255,255,.35);
      font-size:1.2rem;cursor:pointer;padding:6px;flex-shrink:0;
      transition:color .15s;border-radius:6px;
    }
    .ap-track-dots:hover{color:#fff;background:rgba(255,255,255,.07);}
    .ap-loading{text-align:center;padding:50px 20px;color:var(--muted);font-size:.9rem;}

    /* ── CATEGORY PAGE ── */
    .cat-page{}
    .cat-hero{position:relative;width:100%;height:190px;overflow:hidden;flex-shrink:0;}
    .cat-hero-bg{position:absolute;inset:0;}
    .cat-hero-gradient{
      position:absolute;inset:0;
      background:linear-gradient(to bottom,rgba(0,0,0,.12) 0%,rgba(8,8,15,.88) 100%);
    }
    .cat-hero-back{
      position:absolute;top:16px;left:16px;z-index:10;
      width:36px;height:36px;border-radius:50%;
      background:rgba(0,0,0,.4);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
      border:none;display:flex;align-items:center;justify-content:center;
      cursor:pointer;color:#fff;transition:background .15s;
    }
    .cat-hero-back:hover{background:rgba(0,0,0,.65);}
    .cat-hero-title{
      position:absolute;bottom:20px;left:20px;
      font-size:2.2rem;font-weight:900;color:#fff;
      letter-spacing:-.02em;text-shadow:0 2px 16px rgba(0,0,0,.5);
    }
    .cat-hero-icon{
      position:absolute;right:-8px;bottom:-14px;
      font-size:8rem;opacity:.18;line-height:1;pointer-events:none;
    }
    .cat-section{padding:20px 18px 4px;}
    .cat-section-title{font-size:1.1rem;font-weight:800;color:#fff;margin-bottom:14px;letter-spacing:-.01em;}
    .playlist-scroll{display:flex;gap:14px;overflow-x:auto;padding:0 18px 16px;scrollbar-width:none;}
    .playlist-scroll::-webkit-scrollbar{display:none;}
    .pl-card{flex-shrink:0;width:146px;cursor:pointer;transition:transform .18s;}
    .pl-card:hover{transform:scale(1.04);}
    .pl-card:active{transform:scale(.96);}
    .pl-card-cover{
      width:146px;height:146px;border-radius:14px;position:relative;overflow:hidden;
      box-shadow:0 6px 20px rgba(0,0,0,.45);margin-bottom:10px;flex-shrink:0;
    }
    .pl-card-cover-grid{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;width:100%;height:100%;}
    .pl-card-cover-grid img{width:100%;height:100%;object-fit:cover;}
    .pl-card-cover-single{
      position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:4.5rem;
    }
    .pl-card-name{font-size:.84rem;font-weight:700;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .pl-card-desc{font-size:.72rem;color:var(--muted);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}

    /* ── PLAYLIST PAGE ── */
    .playlist-page{position:relative;min-height:100%;}
    .playlist-hero{position:relative;width:100%;height:255px;overflow:hidden;flex-shrink:0;}
    .pl-hero-cover-grid{
      position:absolute;inset:0;
      display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;
    }
    .pl-hero-cover-grid img{width:100%;height:100%;object-fit:cover;}
    .pl-hero-cover-single{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:6rem;}
    .pl-hero-gradient{
      position:absolute;inset:0;
      background:linear-gradient(to bottom,rgba(0,0,0,.15) 0%,rgba(8,8,15,0) 35%,rgba(8,8,15,.88) 78%,var(--bg) 100%);
    }
    .pl-hero-back{
      position:absolute;top:16px;left:16px;z-index:10;
      width:36px;height:36px;border-radius:50%;
      background:rgba(0,0,0,.45);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
      border:none;display:flex;align-items:center;justify-content:center;
      cursor:pointer;color:#fff;transition:background .15s;
    }
    .pl-hero-back:hover{background:rgba(0,0,0,.65);}
    .pl-hero-info{position:absolute;bottom:16px;left:18px;right:18px;z-index:5;}
    .pl-hero-name{font-size:1.7rem;font-weight:900;color:#fff;letter-spacing:-.02em;line-height:1.15;text-shadow:0 2px 14px rgba(0,0,0,.5);}
    .pl-hero-desc{font-size:.78rem;color:rgba(255,255,255,.65);margin-top:6px;}
    .pl-actions{display:flex;align-items:center;gap:12px;padding:14px 18px 10px;}
    .pl-act-btn{
      background:none;border:none;color:rgba(255,255,255,.45);cursor:pointer;
      padding:6px;border-radius:50%;transition:color .15s,background .15s;flex-shrink:0;
    }
    .pl-act-btn:hover{color:#fff;background:rgba(255,255,255,.08);}
    .pl-spacer{flex:1;}
    .pl-shuffle-btn{background:none;border:none;color:rgba(255,255,255,.55);cursor:pointer;padding:6px;transition:color .15s;flex-shrink:0;}
    .pl-shuffle-btn:hover{color:#fff;}
    .pl-play-btn{
      width:54px;height:54px;border-radius:50%;background:#fff;border:none;
      display:flex;align-items:center;justify-content:center;
      cursor:pointer;flex-shrink:0;
      transition:background .15s,transform .12s;box-shadow:0 4px 22px rgba(0,0,0,.4);
    }
    .pl-play-btn:hover{background:#e8e8e8;transform:scale(1.06);}
    .pl-track-row{
      display:flex;align-items:center;gap:14px;
      padding:8px 18px;cursor:pointer;transition:background .15s;border-radius:10px;
    }
    .pl-track-row:hover{background:rgba(255,255,255,.07);}
    .pl-track-num{width:24px;text-align:right;font-size:.88rem;color:var(--muted);font-weight:500;flex-shrink:0;}
    .pl-track-num.playing{color:var(--p);}
    .pl-track-cover{width:50px;height:50px;border-radius:8px;object-fit:cover;flex-shrink:0;box-shadow:0 2px 10px rgba(0,0,0,.3);}
    .pl-track-cover-ph{
      width:50px;height:50px;border-radius:8px;flex-shrink:0;
      background:linear-gradient(135deg,rgba(168,85,247,.3),rgba(99,102,241,.3));
      display:flex;align-items:center;justify-content:center;font-size:1.3rem;
    }
    .pl-track-info{flex:1;min-width:0;}
    .pl-track-title{font-size:.92rem;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .pl-track-title.playing{color:var(--p);}
    .pl-track-meta{font-size:.74rem;color:var(--muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .pl-track-dots{background:none;border:none;color:rgba(255,255,255,.3);font-size:1.2rem;cursor:pointer;padding:6px;flex-shrink:0;border-radius:6px;transition:color .15s;}
    .pl-track-dots:hover{color:#fff;background:rgba(255,255,255,.07);}

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
      .topbar-right .avatar{display:none;}
      .vol-wrap,.prog-times{display:none;}
      .album-grid{grid-template-columns:repeat(2,1fr);}
    }

    #yt-holder{position:fixed;bottom:-2px;left:-2px;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;}
    #yt-anchor{width:100%;height:100%;border:none;}

    /* ══ FULL PLAYER ══════════════════════════════════════════════════════ */
    .full-player{
      position:fixed;inset:0;z-index:400;
      transform:translateY(100%);
      transition:transform .38s cubic-bezier(.32,.72,0,1);
      display:flex;flex-direction:column;
      overflow:hidden;
    }
    .full-player.open{transform:translateY(0);}
    .fp-bg{
      position:absolute;inset:0;z-index:0;
      background:linear-gradient(180deg,#1a0a2e 0%,#080814 55%,#050510 100%);
      transition:background 1s;
    }
    .fp-bg-art{
      position:absolute;inset:-30px;z-index:0;
      background-size:cover;background-position:center;
      filter:blur(70px) saturate(2.5) brightness(.28);
      transform:scale(1.15);
      transition:background-image .8s;
    }
    .fp-content{position:absolute;inset:0;z-index:1;display:flex;flex-direction:column;overflow-y:scroll;overflow-x:hidden;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;}
    .fp-content::-webkit-scrollbar{display:none;}

    /* Header */
    .fp-header{
      display:flex;align-items:center;justify-content:space-between;
      padding:env(safe-area-inset-top,16px) 20px 10px;
      padding-top:max(env(safe-area-inset-top),16px);
      flex-shrink:0;
    }
    .fp-back{
      width:40px;height:40px;border-radius:50%;
      border:none;background:rgba(255,255,255,.1);backdrop-filter:blur(8px);
      color:#fff;display:flex;align-items:center;justify-content:center;
      cursor:pointer;transition:all .18s;
    }
    .fp-back:hover{background:rgba(255,255,255,.18);}
    .fp-mode-toggle{
      display:flex;align-items:center;
      background:rgba(255,255,255,.1);backdrop-filter:blur(16px);
      border:1px solid rgba(255,255,255,.14);border-radius:50px;padding:4px;
    }
    .fp-mode-btn{
      display:flex;align-items:center;gap:6px;
      padding:7px 18px;border-radius:50px;
      border:none;background:transparent;
      color:rgba(255,255,255,.5);font-size:.8rem;font-weight:700;
      cursor:pointer;transition:all .22s;font-family:inherit;letter-spacing:.2px;
    }
    .fp-mode-btn.active{background:rgba(255,255,255,.18);color:#fff;box-shadow:0 2px 12px rgba(0,0,0,.3);}
    .fp-hdr-right{display:flex;gap:8px;}
    .fp-icon-btn{
      width:38px;height:38px;border-radius:50%;
      border:none;background:rgba(255,255,255,.08);backdrop-filter:blur(8px);
      color:rgba(255,255,255,.7);display:flex;align-items:center;justify-content:center;
      cursor:pointer;transition:all .18s;
    }
    .fp-icon-btn:hover{background:rgba(255,255,255,.16);color:#fff;}

    /* Media */
    .fp-media{
      flex-shrink:0;padding:8px 20px 0;
      display:flex;align-items:center;justify-content:center;
    }
    .fp-art{
      width:100%;max-width:min(260px,62vw);aspect-ratio:1;
      border-radius:20px;overflow:hidden;
      box-shadow:0 32px 96px rgba(0,0,0,.65);
      border:1px solid rgba(255,255,255,.08);
      background:rgba(255,255,255,.06);
      transition:transform .3s,box-shadow .3s;
    }
    .fp-art.playing{transform:scale(1.02);animation:art-glow 3s ease-in-out infinite alternate;}
    @keyframes art-glow{
      from{box-shadow:0 36px 90px rgba(0,0,0,.7),0 0 40px rgba(168,85,247,.25);}
      to{box-shadow:0 44px 110px rgba(0,0,0,.75),0 0 80px rgba(168,85,247,.5);}
    }
    .fp-art img{width:100%;height:100%;object-fit:cover;display:block;}
    .fp-art-ph{width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:5rem;background:linear-gradient(135deg,rgba(168,85,247,.25),rgba(99,102,241,.25));}
    .fp-video-wrap{
      width:100%;aspect-ratio:16/9;
      border-radius:16px;overflow:hidden;
      background:#000;
      box-shadow:0 20px 60px rgba(0,0,0,.7);
      border:1px solid rgba(255,255,255,.08);
    }

    /* Info */
    .fp-info{
      display:flex;align-items:center;justify-content:space-between;gap:12px;
      padding:14px 24px 4px;flex-shrink:0;
    }
    .fp-info-left{flex:1;min-width:0;}
    .fp-title{
      font-size:1.45rem;font-weight:800;letter-spacing:-.4px;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.2;
      cursor:pointer;
    }
    .fp-title-chevron{display:inline;opacity:.6;font-size:.9em;margin-left:4px;}
    .fp-artist{font-size:.9rem;color:rgba(255,255,255,.6);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .fp-heart-btn{
      width:40px;height:40px;border-radius:50%;
      border:1.5px solid rgba(255,255,255,.18);background:rgba(255,255,255,.07);
      color:rgba(255,255,255,.65);display:flex;align-items:center;justify-content:center;
      cursor:pointer;transition:all .2s;flex-shrink:0;
    }
    .fp-heart-btn.liked{background:rgba(236,72,153,.2);border-color:rgba(236,72,153,.6);color:#ec4899;}

    /* Info title row */
    .fp-title-row{display:flex;align-items:center;gap:8px;}

    /* Equalizer bars */
    .fp-eq{display:none;align-items:flex-end;gap:2px;height:16px;flex-shrink:0;}
    .fp-eq.active{display:flex;}
    .fp-eq-bar{width:3px;border-radius:2px;background:linear-gradient(to top,var(--p2),var(--p));animation:eq-bounce 1.1s ease-in-out infinite;}
    .fp-eq-bar:nth-child(1){height:8px;animation-delay:0s;}
    .fp-eq-bar:nth-child(2){height:14px;animation-delay:.18s;}
    .fp-eq-bar:nth-child(3){height:10px;animation-delay:.09s;}
    .fp-eq-bar:nth-child(4){height:16px;animation-delay:.27s;}
    @keyframes eq-bounce{0%,100%{transform:scaleY(.35);}50%{transform:scaleY(1);}}

    /* Action pills */
    .fp-actions{
      display:flex;align-items:center;gap:8px;
      padding:6px 22px 14px;overflow-x:auto;flex-shrink:0;
    }
    .fp-actions::-webkit-scrollbar{display:none;}
    .fp-pill{
      display:flex;align-items:center;gap:6px;
      padding:9px 20px;border-radius:50px;
      border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.07);
      color:rgba(255,255,255,.85);font-size:.82rem;font-weight:600;
      cursor:pointer;transition:all .18s;white-space:nowrap;flex-shrink:0;
      font-family:inherit;backdrop-filter:blur(12px);
    }
    .fp-pill:hover{background:rgba(255,255,255,.15);color:#fff;border-color:rgba(255,255,255,.28);}
    .fp-pill.on{background:rgba(168,85,247,.25);border-color:rgba(168,85,247,.55);color:#fff;}

    /* Volume row */
    .fp-vol-row{
      display:flex;align-items:center;gap:12px;
      padding:0 26px 18px;flex-shrink:0;
    }
    .fp-vol-row svg{color:rgba(255,255,255,.38);flex-shrink:0;}
    .fp-vol-slider{
      flex:1;-webkit-appearance:none;height:4px;
      background:rgba(255,255,255,.14);border-radius:4px;outline:none;cursor:pointer;
    }
    .fp-vol-slider::-webkit-slider-thumb{
      -webkit-appearance:none;width:16px;height:16px;border-radius:50%;
      background:linear-gradient(135deg,var(--p),var(--p2));
      box-shadow:0 2px 10px rgba(168,85,247,.6);cursor:pointer;
    }

    /* Progress */
    .fp-prog-wrap{padding:0 24px 4px;flex-shrink:0;}
    .fp-prog-track{
      width:100%;height:4px;background:rgba(255,255,255,.14);border-radius:4px;
      cursor:pointer;position:relative;transition:height .15s;
    }
    .fp-prog-track:hover{height:7px;}
    .fp-prog-fill{
      height:100%;border-radius:4px;
      background:linear-gradient(90deg,var(--p),var(--p2));
      pointer-events:none;transition:width .5s linear;
      position:relative;
    }
    .fp-prog-thumb{
      position:absolute;right:-6px;top:50%;transform:translateY(-50%);
      width:14px;height:14px;border-radius:50%;
      background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.5);
      pointer-events:none;opacity:0;transition:opacity .15s;
    }
    .fp-prog-track:hover .fp-prog-thumb{opacity:1;}
    .fp-prog-times{display:flex;justify-content:space-between;padding-top:6px;font-size:.72rem;color:rgba(255,255,255,.45);font-weight:500;}

    /* Controls */
    .fp-controls{
      display:flex;align-items:center;justify-content:space-between;
      padding:8px 24px 10px;flex-shrink:0;
    }
    .fp-ctrl{
      width:46px;height:46px;border-radius:50%;
      border:none;background:transparent;
      color:rgba(255,255,255,.6);
      display:flex;align-items:center;justify-content:center;
      cursor:pointer;transition:all .18s;
    }
    .fp-ctrl:hover{background:rgba(255,255,255,.08);color:#fff;}
    .fp-ctrl.on{color:var(--p);}
    .fp-ctrl.on svg{filter:drop-shadow(0 0 6px rgba(168,85,247,.8));}
    .fp-play-btn{
      width:72px;height:72px;border-radius:50%;
      border:none;background:linear-gradient(135deg,var(--p),var(--p2));color:#fff;
      display:flex;align-items:center;justify-content:center;
      cursor:pointer;transition:all .22s;
      box-shadow:0 8px 36px rgba(168,85,247,.55);
    }
    .fp-play-btn:hover{transform:scale(1.07);box-shadow:0 14px 48px rgba(168,85,247,.75);}
    .fp-play-btn:active{transform:scale(.93);}

    /* Queue */
    .fp-queue{margin:4px 16px 24px;border-radius:18px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);flex-shrink:0;}
    .fp-q-hdr{display:flex;align-items:center;justify-content:space-between;padding:14px 16px 10px;border-bottom:1px solid rgba(255,255,255,.06);}
    .fp-q-from{font-size:.68rem;color:rgba(255,255,255,.4);font-weight:500;letter-spacing:.3px;text-transform:uppercase;}
    .fp-q-name{font-size:.9rem;font-weight:700;margin-top:3px;}
    .fp-q-save{
      display:flex;align-items:center;gap:6px;
      background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);
      border-radius:50px;padding:8px 16px;
      font-size:.78rem;font-weight:600;color:rgba(255,255,255,.75);
      cursor:pointer;transition:all .18s;font-family:inherit;
    }
    .fp-q-save:hover{background:rgba(255,255,255,.13);color:#fff;}
    .fp-q-chips{display:flex;gap:7px;padding:10px 12px;overflow-x:auto;}
    .fp-q-chips::-webkit-scrollbar{display:none;}
    .fp-q-chip{
      flex-shrink:0;padding:6px 14px;border-radius:50px;
      background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);
      font-size:.75rem;font-weight:600;color:rgba(255,255,255,.55);cursor:pointer;transition:all .18s;
    }
    .fp-q-chip.active{background:rgba(255,255,255,.16);color:#fff;border-color:rgba(255,255,255,.28);}
    .fp-q-row{
      display:flex;align-items:center;gap:12px;padding:10px 14px;
      cursor:pointer;transition:background .15s;border-top:1px solid rgba(255,255,255,.04);
    }
    .fp-q-row:hover{background:rgba(255,255,255,.04);}
    .fp-q-row.now{background:rgba(168,85,247,.1);}
    .fp-q-cover{width:42px;height:42px;border-radius:9px;object-fit:cover;flex-shrink:0;background:rgba(255,255,255,.08);}
    .fp-q-cover-ph{width:42px;height:42px;border-radius:9px;flex-shrink:0;background:linear-gradient(135deg,rgba(168,85,247,.2),rgba(99,102,241,.2));display:flex;align-items:center;justify-content:center;font-size:.9rem;}
    .fp-q-info{flex:1;min-width:0;}
    .fp-q-title{font-size:.875rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .fp-q-artist{font-size:.72rem;color:rgba(255,255,255,.5);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .fp-q-row.now .fp-q-title{color:var(--p);}
    .fp-q-dots{width:30px;height:30px;border-radius:50%;border:none;background:transparent;color:rgba(255,255,255,.35);display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:1rem;transition:all .15s;}
    .fp-q-dots:hover{background:rgba(255,255,255,.08);color:#fff;}

    @media(min-width:768px){
      .fp-art{max-width:380px;}
      .fp-title{font-size:1.6rem;}
      .fp-controls{padding:14px 40px 18px;}
      .fp-media{padding:20px 48px 0;}
    }

    /* ── CONTEXT MENU ── */
    .ctx-overlay{position:fixed;inset:0;z-index:600;background:transparent;}
    .ctx-menu{
      position:fixed;z-index:601;
      background:rgba(18,18,30,0.97);
      border:1px solid rgba(255,255,255,.13);
      border-radius:16px;padding:6px;
      min-width:210px;
      box-shadow:0 20px 60px rgba(0,0,0,.7);
      backdrop-filter:blur(20px);
      animation:ctxIn .15s ease;
    }
    @keyframes ctxIn{from{opacity:0;transform:scale(.94);}to{opacity:1;transform:scale(1);}}
    .ctx-item{
      display:flex;align-items:center;gap:12px;
      padding:11px 14px;border-radius:10px;
      font-size:.875rem;font-weight:500;color:rgba(255,255,255,.85);
      cursor:pointer;border:none;background:none;width:100%;text-align:left;
      font-family:inherit;transition:background .12s;
    }
    .ctx-item:hover{background:rgba(255,255,255,.08);color:#fff;}
    .ctx-item.danger{color:#f87171;}
    .ctx-item.danger:hover{background:rgba(248,113,113,.1);}
    .ctx-sep{height:1px;background:rgba(255,255,255,.07);margin:4px 0;}

    /* ── PROFILE PANEL ── */
    .profile-overlay{position:fixed;inset:0;z-index:500;background:rgba(0,0,0,.4);backdrop-filter:blur(4px);opacity:0;pointer-events:none;transition:opacity .2s;}
    .profile-overlay.open{opacity:1;pointer-events:all;}
    .profile-panel{
      position:fixed;top:68px;right:16px;z-index:501;
      background:rgba(16,16,28,0.97);
      border:1px solid rgba(255,255,255,.12);
      border-radius:20px;padding:20px;
      min-width:240px;
      box-shadow:0 24px 64px rgba(0,0,0,.7);
      backdrop-filter:blur(24px);
      transform:translateY(-12px) scale(.96);opacity:0;
      transition:transform .22s cubic-bezier(.32,.72,0,1),opacity .2s;
      pointer-events:none;
    }
    .profile-overlay.open .profile-panel{transform:translateY(0) scale(1);opacity:1;pointer-events:all;}
    .profile-avatar-lg{
      width:56px;height:56px;border-radius:50%;
      background:linear-gradient(135deg,var(--p),var(--p2));
      display:flex;align-items:center;justify-content:center;
      font-size:1.4rem;font-weight:700;margin:0 auto 12px;
      border:2px solid rgba(168,85,247,.4);
    }
    .profile-name{font-size:1rem;font-weight:700;text-align:center;}
    .profile-sub{font-size:.75rem;color:var(--muted);text-align:center;margin-top:3px;}
    .profile-sep{height:1px;background:rgba(255,255,255,.07);margin:14px 0;}
    .profile-stat{display:flex;justify-content:space-around;gap:8px;margin-bottom:14px;}
    .profile-stat-item{text-align:center;}
    .profile-stat-num{font-size:1.1rem;font-weight:800;background:linear-gradient(90deg,var(--p),var(--p2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;}
    .profile-stat-lbl{font-size:.65rem;color:var(--muted);margin-top:2px;}
    .profile-btn{
      display:flex;align-items:center;gap:10px;
      padding:10px 12px;border-radius:10px;
      font-size:.85rem;font-weight:500;color:rgba(255,255,255,.75);
      cursor:pointer;border:none;background:none;width:100%;text-align:left;
      font-family:inherit;transition:background .12s;
    }
    .profile-btn:hover{background:rgba(255,255,255,.06);color:#fff;}

    /* ── SHARE MODAL ── */
    .share-overlay{position:fixed;inset:0;z-index:700;background:rgba(0,0,0,.6);backdrop-filter:blur(8px);display:flex;align-items:flex-end;justify-content:center;opacity:0;pointer-events:none;transition:opacity .2s;}
    .share-overlay.open{opacity:1;pointer-events:all;}
    .share-sheet{
      width:100%;max-width:500px;
      background:rgba(16,16,28,.98);
      border:1px solid rgba(255,255,255,.1);
      border-radius:24px 24px 0 0;
      padding:24px 24px 32px;
      transform:translateY(100%);
      transition:transform .3s cubic-bezier(.32,.72,0,1);
    }
    .share-overlay.open .share-sheet{transform:translateY(0);}
    .share-handle{width:36px;height:4px;background:rgba(255,255,255,.2);border-radius:4px;margin:0 auto 20px;}
    .share-title{font-size:1rem;font-weight:700;margin-bottom:4px;}
    .share-sub{font-size:.78rem;color:var(--muted);margin-bottom:20px;}
    .share-opts{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px;}
    .share-opt{display:flex;flex-direction:column;align-items:center;gap:8px;cursor:pointer;}
    .share-opt-icon{
      width:52px;height:52px;border-radius:16px;
      background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);
      display:flex;align-items:center;justify-content:center;font-size:1.3rem;
      transition:all .15s;
    }
    .share-opt:hover .share-opt-icon{background:rgba(168,85,247,.2);border-color:rgba(168,85,247,.4);}
    .share-opt-lbl{font-size:.68rem;color:var(--muted);font-weight:500;}
    .share-link-row{
      display:flex;align-items:center;gap:10px;
      background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);
      border-radius:12px;padding:12px 14px;
    }
    .share-link-text{flex:1;font-size:.78rem;color:var(--muted);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}
    .share-copy-btn{
      flex-shrink:0;padding:6px 14px;border-radius:8px;
      background:linear-gradient(135deg,var(--p),var(--p2));
      border:none;color:#fff;font-size:.78rem;font-weight:700;
      cursor:pointer;font-family:inherit;transition:opacity .15s;
    }
    .share-copy-btn:hover{opacity:.85;}

    /* ── EQ MODAL ── */
    .eq-overlay{position:fixed;inset:0;z-index:700;background:rgba(0,0,0,.6);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;transition:opacity .2s;padding:20px;}
    .eq-overlay.open{opacity:1;pointer-events:all;}
    .eq-modal{
      width:100%;max-width:400px;
      background:rgba(14,14,26,.98);
      border:1px solid rgba(255,255,255,.12);
      border-radius:24px;padding:24px;
      transform:scale(.9);
      transition:transform .25s cubic-bezier(.32,.72,0,1);
      box-shadow:0 32px 80px rgba(0,0,0,.7);
    }
    .eq-overlay.open .eq-modal{transform:scale(1);}
    .eq-modal-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:22px;}
    .eq-modal-title{font-size:1.05rem;font-weight:700;}
    .eq-close{width:32px;height:32px;border-radius:50%;border:none;background:rgba(255,255,255,.08);color:var(--muted);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:1rem;transition:all .15s;}
    .eq-close:hover{background:rgba(255,255,255,.15);color:#fff;}
    .eq-presets{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px;}
    .eq-preset{padding:6px 14px;border-radius:50px;font-size:.75rem;font-weight:600;cursor:pointer;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:var(--muted);transition:all .15s;}
    .eq-preset.active,.eq-preset:hover{background:rgba(168,85,247,.2);border-color:rgba(168,85,247,.5);color:#fff;}
    .eq-bands{display:flex;align-items:flex-end;justify-content:space-between;gap:10px;height:120px;padding:0 4px;margin-bottom:16px;}
    .eq-band{display:flex;flex-direction:column;align-items:center;gap:6px;flex:1;}
    .eq-band-wrap{flex:1;display:flex;align-items:center;justify-content:center;width:100%;}
    input[type=range].eq-slider{-webkit-appearance:none;writing-mode:vertical-lr;direction:rtl;width:28px;height:90px;background:transparent;cursor:pointer;}
    input[type=range].eq-slider::-webkit-slider-runnable-track{width:4px;background:rgba(255,255,255,.12);border-radius:4px;}
    input[type=range].eq-slider::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:var(--p);border:2px solid #fff;box-shadow:0 2px 8px rgba(168,85,247,.5);}
    .eq-band-lbl{font-size:.62rem;color:var(--muted);font-weight:600;}
    .eq-vol-row{display:flex;align-items:center;gap:12px;padding-top:8px;border-top:1px solid rgba(255,255,255,.07);}
    .eq-vol-lbl{font-size:.78rem;color:var(--muted);font-weight:600;white-space:nowrap;}
    input[type=range].vol-full{-webkit-appearance:none;flex:1;height:4px;background:rgba(255,255,255,.15);border-radius:4px;outline:none;cursor:pointer;}
    input[type=range].vol-full::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:var(--p);border:2px solid #fff;}

    /* ── LIBRARY ── */
    .lib-header{margin-bottom:20px;}
    .lib-tabs{display:flex;gap:6px;margin-bottom:20px;}
    .lib-tab{
      padding:8px 18px;border-radius:50px;font-size:.82rem;font-weight:700;cursor:pointer;
      border:1px solid var(--border2);background:var(--glass);color:var(--muted);transition:all .18s;
    }
    .lib-tab.active{background:rgba(168,85,247,.2);border-color:rgba(168,85,247,.5);color:#fff;}
    .lib-empty-cta{
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      padding:60px 20px;gap:14px;
    }
    .lib-empty-icon{font-size:3rem;opacity:.4;}
    .lib-empty-text{font-size:.9rem;color:var(--muted);text-align:center;}
    .lib-empty-btn{
      margin-top:4px;padding:10px 24px;border-radius:50px;
      background:linear-gradient(135deg,var(--p),var(--p2));
      border:none;color:#fff;font-size:.85rem;font-weight:700;
      cursor:pointer;font-family:inherit;
      box-shadow:0 4px 20px rgba(168,85,247,.4);
      transition:opacity .15s;
    }
    .lib-empty-btn:hover{opacity:.85;}

    /* ── LIKED BADGE ── */
    .liked-badge{
      width:20px;height:20px;border-radius:50%;
      background:rgba(236,72,153,.2);
      display:flex;align-items:center;justify-content:center;
      font-size:.6rem;flex-shrink:0;
    }

    /* ── RECENTLY PLAYED ── */
    .recently-row{
      display:flex;align-items:center;gap:12px;
      padding:10px 14px;border-radius:12px;
      cursor:pointer;transition:background .15s;
    }
    .recently-row:hover{background:rgba(255,255,255,.04);}

    /* ── KEYBOARD HINT ── */
    .kbd-hint{
      position:fixed;bottom:130px;right:20px;z-index:200;
      background:rgba(18,18,30,.95);border:1px solid rgba(255,255,255,.1);
      border-radius:12px;padding:10px 14px;
      font-size:.72rem;color:var(--muted);
      pointer-events:none;
      opacity:0;transition:opacity .3s;
    }
    .kbd-hint.show{opacity:1;}
    kbd{
      display:inline-flex;align-items:center;justify-content:center;
      min-width:20px;height:20px;padding:0 5px;
      background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.15);
      border-radius:5px;font-size:.7rem;font-family:inherit;color:#fff;margin:0 2px;
    }
    @media(max-width:767px){.kbd-hint{display:none;}}
  </style>
</head>
<body>
<div id="yt-holder"><div id="yt-anchor"></div></div>
<div class="toast" id="toast"></div>
<div class="kbd-hint" id="kbdHint">
  <kbd>Space</kbd> Play/Pausa &nbsp; <kbd>→</kbd> Siguiente &nbsp; <kbd>←</kbd> Anterior &nbsp; <kbd>L</kbd> Like
</div>

<!-- CONTEXT MENU -->
<div class="ctx-overlay" id="ctxOverlay" style="display:none"></div>
<div class="ctx-menu" id="ctxMenu" style="display:none">
  <button class="ctx-item" id="ctxPlay">▶ &nbsp; Reproducir ahora</button>
  <button class="ctx-item" id="ctxAddQueue">
    <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
    Agregar a la fila
  </button>
  <button class="ctx-item" id="ctxLike">
    <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
    Me gusta
  </button>
  <button class="ctx-item" id="ctxShare">
    <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
    Compartir canción
  </button>
  <div class="ctx-sep"></div>
  <button class="ctx-item danger" id="ctxRemove">
    <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
    Quitar de la lista
  </button>
</div>

<!-- PROFILE PANEL -->
<div class="profile-overlay" id="profileOverlay">
  <div class="profile-panel" id="profilePanel">
    <div class="profile-avatar-lg">🎧</div>
    <div class="profile-name">Pancho Mix</div>
    <div class="profile-sub">Oyente apasionado</div>
    <div class="profile-sep"></div>
    <div class="profile-stat">
      <div class="profile-stat-item">
        <div class="profile-stat-num" id="statLiked">0</div>
        <div class="profile-stat-lbl">Me gustan</div>
      </div>
      <div class="profile-stat-item">
        <div class="profile-stat-num" id="statPlayed">0</div>
        <div class="profile-stat-lbl">Escuchadas</div>
      </div>
      <div class="profile-stat-item">
        <div class="profile-stat-num" id="statQueue">0</div>
        <div class="profile-stat-lbl">En fila</div>
      </div>
    </div>
    <div class="profile-sep"></div>
    <button class="profile-btn" id="profileEqBtn">
      <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>
      Ecualizador
    </button>
    <button class="profile-btn" onclick="setView('library');document.getElementById('profileOverlay').classList.remove('open')">
      <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
      Canciones que me gustan
    </button>
    <button class="profile-btn" id="profileClearBtn">
      <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
      Limpiar historial
    </button>
  </div>
</div>

<!-- SHARE MODAL -->
<div class="share-overlay" id="shareOverlay">
  <div class="share-sheet">
    <div class="share-handle"></div>
    <div class="share-title" id="shareTitle">Compartir canción</div>
    <div class="share-sub" id="shareArtist">—</div>
    <div class="share-opts">
      <div class="share-opt" id="shareWhatsapp">
        <div class="share-opt-icon">💬</div>
        <div class="share-opt-lbl">WhatsApp</div>
      </div>
      <div class="share-opt" id="shareTelegram">
        <div class="share-opt-icon">✈️</div>
        <div class="share-opt-lbl">Telegram</div>
      </div>
      <div class="share-opt" id="shareTwitter">
        <div class="share-opt-icon">🐦</div>
        <div class="share-opt-lbl">Twitter</div>
      </div>
      <div class="share-opt" id="shareCopy">
        <div class="share-opt-icon">🔗</div>
        <div class="share-opt-lbl">Copiar link</div>
      </div>
    </div>
    <div class="share-link-row">
      <div class="share-link-text" id="shareLinkText">https://pancho-mix.replit.app/</div>
      <button class="share-copy-btn" id="shareCopyBtn">Copiar</button>
    </div>
  </div>
</div>

<!-- EQ MODAL -->
<div class="eq-overlay" id="eqOverlay">
  <div class="eq-modal">
    <div class="eq-modal-hdr">
      <div class="eq-modal-title">🎚️ Ecualizador</div>
      <button class="eq-close" id="eqClose">✕</button>
    </div>
    <div class="eq-presets" id="eqPresets">
      <div class="eq-preset active" data-preset="flat">Normal</div>
      <div class="eq-preset" data-preset="bass">Bass Boost</div>
      <div class="eq-preset" data-preset="pop">Pop</div>
      <div class="eq-preset" data-preset="rock">Rock</div>
      <div class="eq-preset" data-preset="electronic">Electrónica</div>
      <div class="eq-preset" data-preset="vocal">Vocal</div>
    </div>
    <div class="eq-bands" id="eqBands">
      <div class="eq-band"><div class="eq-band-wrap"><input type="range" class="eq-slider" min="-12" max="12" value="0" data-band="0"></div><div class="eq-band-lbl">60</div></div>
      <div class="eq-band"><div class="eq-band-wrap"><input type="range" class="eq-slider" min="-12" max="12" value="0" data-band="1"></div><div class="eq-band-lbl">250</div></div>
      <div class="eq-band"><div class="eq-band-wrap"><input type="range" class="eq-slider" min="-12" max="12" value="0" data-band="2"></div><div class="eq-band-lbl">1K</div></div>
      <div class="eq-band"><div class="eq-band-wrap"><input type="range" class="eq-slider" min="-12" max="12" value="0" data-band="3"></div><div class="eq-band-lbl">4K</div></div>
      <div class="eq-band"><div class="eq-band-wrap"><input type="range" class="eq-slider" min="-12" max="12" value="0" data-band="4"></div><div class="eq-band-lbl">16K</div></div>
    </div>
    <div class="eq-vol-row">
      <div class="eq-vol-lbl">🔊 Volumen</div>
      <input type="range" class="vol-full" id="eqVolSlider" min="0" max="100" value="100">
      <div style="font-size:.75rem;color:var(--muted);width:30px;text-align:right" id="eqVolVal">100%</div>
    </div>
  </div>
</div>

<!-- ══ FULL PLAYER ══════════════════════════════════════════════════════════ -->
<div class="full-player" id="fullPlayer">
  <div class="fp-bg"></div>
  <div class="fp-bg-art" id="fpBgArt"></div>
  <div class="fp-content">

    <!-- Header -->
    <div class="fp-header">
      <button class="fp-back" id="fpBack">
        <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
      </button>
      <div class="fp-mode-toggle">
        <button class="fp-mode-btn" id="fpModeAudio">
          <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z"/><path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>
          Audio
        </button>
        <button class="fp-mode-btn" id="fpModeVideo">
          <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="2" y="7" width="15" height="10" rx="2"/><polyline points="17 11 22 7 22 17 17 13"/></svg>
          Video
        </button>
      </div>
      <div class="fp-hdr-right">
        <button class="fp-icon-btn" id="fpShareBtn" title="Compartir">
          <svg width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
        </button>
        <button class="fp-icon-btn" id="fpMoreBtn" title="Más opciones">
          <svg width="17" height="17" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
        </button>
      </div>
    </div>

    <!-- Media -->
    <div class="fp-media">
      <div class="fp-art" id="fpArt">
        <div class="fp-art-ph" id="fpArtPh">🎵</div>
      </div>
      <div class="fp-video-wrap" id="fpVideoWrap" style="display:none"></div>
    </div>

    <!-- Info -->
    <div class="fp-info">
      <div class="fp-info-left">
        <div class="fp-title-row">
          <div class="fp-title" id="fpTitle">—<span class="fp-title-chevron">›</span></div>
          <div class="fp-eq" id="fpEq">
            <div class="fp-eq-bar"></div>
            <div class="fp-eq-bar"></div>
            <div class="fp-eq-bar"></div>
            <div class="fp-eq-bar"></div>
          </div>
        </div>
        <div class="fp-artist" id="fpArtist">—</div>
      </div>
      <button class="fp-heart-btn" id="fpHeartBtn">
        <svg width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
      </button>
    </div>

    <!-- Action pills -->
    <div class="fp-actions">
      <button class="fp-pill" id="fpLyricsPill">🎵 Letra</button>
      <button class="fp-pill" id="fpQueuePill">☰ Fila</button>
    </div>

    <!-- Progress -->
    <div class="fp-prog-wrap">
      <div class="fp-prog-track" id="fpProgTrack">
        <div class="fp-prog-fill" id="fpProgFill" style="width:0%">
          <div class="fp-prog-thumb"></div>
        </div>
      </div>
      <div class="fp-prog-times">
        <span id="fpCurrent">0:00</span>
        <span id="fpTotal">0:00</span>
      </div>
    </div>

    <!-- Controls -->
    <div class="fp-controls">
      <button class="fp-ctrl" id="fpShuffle" title="Aleatoria">
        <svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>
      </button>
      <button class="fp-ctrl" id="fpPrevBtn">
        <svg width="26" height="26" fill="currentColor" viewBox="0 0 24 24"><path d="M19 20L9 12l10-8v16zm-10 0H7V4h2v16z"/></svg>
      </button>
      <button class="fp-play-btn" id="fpPlayBtn">
        <svg id="fpIconPlay" width="28" height="28" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        <svg id="fpIconPause" width="28" height="28" fill="currentColor" viewBox="0 0 24 24" style="display:none"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
      </button>
      <button class="fp-ctrl" id="fpNextBtn">
        <svg width="26" height="26" fill="currentColor" viewBox="0 0 24 24"><path d="M5 4l10 8-10 8V4zm10 0h2v16h-2V4z"/></svg>
      </button>
      <button class="fp-ctrl" id="fpRepeat" title="Repetir">
        <svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
      </button>
    </div>

    <!-- Volume -->
    <div class="fp-vol-row">
      <svg width="15" height="15" fill="currentColor" viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5zm4.5 3.5a5 5 0 0 1 0 7"/></svg>
      <input type="range" class="fp-vol-slider" id="fpVolSlider" min="0" max="1" step="0.02" value="1">
      <svg width="15" height="15" fill="currentColor" viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5zm4.5 3.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>
    </div>

    <!-- Queue section -->
    <div class="fp-queue">
      <div class="fp-q-hdr">
        <div>
          <div class="fp-q-from">Reproduciendo desde</div>
          <div class="fp-q-name" id="fpQueueName">Tu fila</div>
        </div>
        <button class="fp-q-save" id="fpQueueSaveBtn">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
          Guardar fila
        </button>
      </div>
      <div class="fp-q-chips">
        <div class="fp-q-chip active">Todos</div>
        <div class="fp-q-chip">Canciones conocidas</div>
        <div class="fp-q-chip">Por descubrir</div>
      </div>
      <div id="fpQueueList"></div>
    </div>

  </div>
</div>

<!-- TOP BAR -->
<div class="topbar">
  <div class="logo" onclick="setView('home')">
    <span class="logo-text">PANCHO MIX</span>
    <span class="logo-badge">PRO</span>
  </div>
  <div class="topbar-right">
    <div class="avatar" id="avatarBtn" title="Perfil">🎧</div>
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

<!-- DICE FAB -->
<button class="dice-fab" id="diceFab" title="Canción aleatoria">
  <span class="dice-emoji">🎲</span>
  <span class="dice-fab-label">Azar</span>
</button>

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
  <button class="nav-item" data-view="trending">
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
let ytCandidates=[], ytCandidateIdx=0;
let currentGenre="trending", currentView="home";
let searchTimeout=null;
let playerMode=localStorage.getItem("playerMode")||"video";
let shuffleOn=false, repeatMode=0; // 0=off, 1=all, 2=one
let liked=false;
let fullPlayerOpen=false;
let touchStartY=0;
let ctxTargetSong=null;
let totalPlayed=0;

// ─── localStorage helpers ─────────────────────────────────────────────────────
const LS={
  get(k){try{return JSON.parse(localStorage.getItem("pm_"+k));}catch{return null;}},
  set(k,v){try{localStorage.setItem("pm_"+k,JSON.stringify(v));}catch{}},
};
let likedSongs=LS.get("liked")||[];
let recentlyPlayed=LS.get("recent")||[];

function isLiked(id){return likedSongs.some(s=>s.id==id);}
function toggleLikeSong(song){
  if(isLiked(song.id)){
    likedSongs=likedSongs.filter(s=>s.id!=song.id);
    showToast("Quitado de Me gusta ♡");
  } else {
    likedSongs.unshift(song);
    if(likedSongs.length>200)likedSongs=likedSongs.slice(0,200);
    showToast("¡Guardado en Me gusta ♥");
  }
  LS.set("liked",likedSongs);
  updateProfileStats();
  if(currentSong&&currentSong.id==song.id){
    liked=isLiked(song.id);
    document.getElementById("fpHeartBtn").classList.toggle("liked",liked);
    const likeNum=parseInt(document.getElementById("fpLikeNum").textContent.replace(/[^0-9]/g,""))||0;
    document.getElementById("fpLikePill").classList.toggle("on",liked);
  }
}

function addToRecentlyPlayed(song){
  recentlyPlayed=recentlyPlayed.filter(s=>s.id!=song.id);
  recentlyPlayed.unshift(song);
  if(recentlyPlayed.length>30)recentlyPlayed=recentlyPlayed.slice(0,30);
  LS.set("recent",recentlyPlayed);
  totalPlayed++;
  updateProfileStats();
}

function updateProfileStats(){
  document.getElementById("statLiked").textContent=likedSongs.length;
  document.getElementById("statPlayed").textContent=totalPlayed;
  document.getElementById("statQueue").textContent=queue.length;
}

// ─── YouTube IFrame API ───────────────────────────────────────────────────────
window.onYouTubeIframeAPIReady=()=>{
  ytPlayer=new YT.Player("yt-anchor",{
    height:"100%",width:"100%",videoId:"",
    host:"https://www.youtube-nocookie.com",
    playerVars:{autoplay:0,controls:0,disablekb:1,fs:0,rel:0,modestbranding:1,iv_load_policy:3,showinfo:0,origin:location.origin},
    events:{
      onReady(){ ytReady=true; },
      onStateChange(e){
        if(e.data===1){
          try{const d=ytPlayer.getDuration();if(d)setDur(d);}catch{}
          startProg(); isPlaying=true; syncPlayBtns(); highlightRows();
        } else if(e.data===2){
          stopProg(); isPlaying=false; syncPlayBtns(); highlightRows();
        } else if(e.data===0){
          stopProg();
          if(repeatMode===2){ try{ytPlayer.seekTo(0,true);ytPlayer.playVideo();}catch{} }
          else nextSong();
        }
      },
      onError(e){
        stopProg();
        // Try next embeddable candidate before giving up
        if(ytCandidates.length>0 && ytCandidateIdx<ytCandidates.length-1){
          ytCandidateIdx++;
          const nextId=ytCandidates[ytCandidateIdx];
          if(currentSong){currentSong.audioUrl="yt:"+nextId;}
          try{ytPlayer.loadVideoById(nextId);}catch{}
        } else {
          showToast("No se encontró audio disponible, pasando...");
          setTimeout(()=>nextSong(),1500);
        }
      }
    }
  });
};
(()=>{const s=document.createElement("script");s.src="https://www.youtube.com/iframe_api";document.head.appendChild(s);})();

// ─── Player helpers ───────────────────────────────────────────────────────────
const fmt=s=>{s=Math.floor(s||0);return Math.floor(s/60)+":"+(s%60<10?"0":"")+s%60;};

function setDur(d){
  duration=d;
  document.getElementById("progDuration").textContent=fmt(d);
  document.getElementById("fpTotal").textContent=fmt(d);
}

function startProg(){
  stopProg();
  progressInterval=setInterval(()=>{
    if(!ytPlayer||!ytReady)return;
    try{
      const t=ytPlayer.getCurrentTime()||0; progress=t;
      const pct=duration>0?(t/duration*100):0;
      document.getElementById("progCurrent").textContent=fmt(t);
      document.getElementById("miniProgressFill").style.width=pct+"%";
      document.getElementById("fpCurrent").textContent=fmt(t);
      document.getElementById("fpProgFill").style.width=pct+"%";
    }catch{}
  },500);
}

function stopProg(){if(progressInterval){clearInterval(progressInterval);progressInterval=null;}}

function syncPlayBtns(){
  document.getElementById("iconPlay").style.display=isPlaying?"none":"block";
  document.getElementById("iconPause").style.display=isPlaying?"block":"none";
  document.getElementById("fpIconPlay").style.display=isPlaying?"none":"block";
  document.getElementById("fpIconPause").style.display=isPlaying?"block":"none";
  document.getElementById("fpArt").classList.toggle("playing",isPlaying);
  document.getElementById("fpEq").classList.toggle("active",isPlaying);
}

function syncRepeatBtn(){
  const btn=document.getElementById("fpRepeat");
  if(repeatMode===0){btn.classList.remove("on");btn.title="Repetir";}
  else if(repeatMode===1){btn.classList.add("on");btn.title="Repetir todo";}
  else{btn.classList.add("on");btn.style.opacity="1";btn.title="Repetir una";}
  btn.innerHTML=repeatMode===2
    ? \`<svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><text x="10" y="14" fill="currentColor" font-size="7" font-weight="bold" stroke="none">1</text></svg>\`
    : \`<svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>\`;
}

function highlightRows(){
  document.querySelectorAll(".song-row").forEach(r=>{
    const active=r.dataset.id==currentSong?.id;
    r.classList.toggle("active",active);
    const eq=r.querySelector(".eq-bars");
    if(eq)eq.style.display=active&&isPlaying?"flex":"none";
  });
  document.querySelectorAll(".fp-q-row").forEach(r=>{
    r.classList.toggle("now",r.dataset.id==currentSong?.id);
  });
}

function getYtId(url){return url?.startsWith("yt:")?url.slice(3):null;}

// ─── Full Player open/close ───────────────────────────────────────────────────
function openFullPlayer(){
  fullPlayerOpen=true;
  document.getElementById("fullPlayer").classList.add("open");
  document.body.style.overflow="hidden";
  updateFullPlayer();
  renderQueueList();
  // Apply saved mode (video or audio) when opening
  setTimeout(()=>setPlayerMode(playerMode),300);
}

function closeFullPlayer(){
  fullPlayerOpen=false;
  document.getElementById("fullPlayer").classList.remove("open");
  document.body.style.overflow="";
  if(playerMode==="video") returnVideoToHolder();
}

function updateFullPlayer(){
  if(!currentSong)return;
  document.getElementById("fpTitle").innerHTML=esc(currentSong.title)+'<span class="fp-title-chevron">›</span>';
  document.getElementById("fpArtist").textContent=currentSong.artistName;
  document.getElementById("fpTotal").textContent=fmt(duration);
  document.getElementById("fpCurrent").textContent=fmt(progress);
  const pct=duration>0?(progress/duration*100):0;
  document.getElementById("fpProgFill").style.width=pct+"%";

  const artEl=document.getElementById("fpArt");
  const artPh=document.getElementById("fpArtPh");
  if(currentSong.albumCover){
    let img=artEl.querySelector("img");
    if(!img){img=document.createElement("img");img.style="width:100%;height:100%;object-fit:cover;display:block;";artPh.style.display="none";artEl.appendChild(img);}
    img.src=currentSong.albumCover;
    document.getElementById("fpBgArt").style.backgroundImage=\`url(\${currentSong.albumCover})\`;
  } else {
    artPh.style.display="flex";
    document.getElementById("fpBgArt").style.backgroundImage="none";
  }

  liked=isLiked(currentSong.id);
  document.getElementById("fpHeartBtn").classList.toggle("liked",liked);
  document.getElementById("fpShuffle").classList.toggle("on",shuffleOn);
  syncRepeatBtn();
}

function renderQueueList(){
  if(!queue.length)return;
  const list=document.getElementById("fpQueueList");
  list.innerHTML=queue.map((s,i)=>\`
    <div class="fp-q-row\${s.id==currentSong?.id?" now":""}" data-id="\${s.id}" data-index="\${i}">
      \${s.albumCover
        ?\`<img class="fp-q-cover" src="\${esc(s.albumCover)}" loading="lazy" onerror="this.outerHTML='<div class=fp-q-cover-ph>♪</div>'">\`
        :\`<div class="fp-q-cover-ph">♪</div>\`}
      <div class="fp-q-info">
        <div class="fp-q-title">\${esc(s.title)}</div>
        <div class="fp-q-artist">\${esc(s.artistName)}</div>
      </div>
      <button class="fp-q-dots" data-qindex="\${i}" onclick="event.stopPropagation();openCtxMenu(event,queue[\${i}])">⋯</button>
    </div>
  \`).join("");

  list.querySelectorAll(".fp-q-row").forEach(row=>{
    row.addEventListener("click",()=>{
      const i=parseInt(row.dataset.index);
      queueIndex=i; playSong(queue[i],null);
    });
  });
}

// ─── Video mode ───────────────────────────────────────────────────────────────
function setPlayerMode(mode){
  playerMode=mode;
  document.getElementById("fpModeAudio").classList.toggle("active",mode==="audio");
  document.getElementById("fpModeVideo").classList.toggle("active",mode==="video");
  const artEl=document.getElementById("fpArt");
  const videoWrap=document.getElementById("fpVideoWrap");
  if(mode==="video"){
    artEl.style.display="none";
    videoWrap.style.display="block";
    if(ytPlayer&&ytReady){
      try{
        const iframe=ytPlayer.getIframe();
        iframe.style.cssText="width:100%;height:100%;border:none;";
        videoWrap.innerHTML=""; videoWrap.appendChild(iframe);
      }catch(e){}
    }
  } else {
    artEl.style.display="";
    videoWrap.style.display="none";
    returnVideoToHolder();
  }
}

function returnVideoToHolder(){
  if(!ytPlayer||!ytReady)return;
  try{
    const iframe=ytPlayer.getIframe();
    const holder=document.getElementById("yt-holder");
    iframe.style.cssText="width:1px;height:1px;opacity:0;pointer-events:none;border:none;";
    if(!holder.contains(iframe))holder.appendChild(iframe);
  }catch(e){}
}

async function playSong(song,newQueue){
  currentSong=song;
  if(newQueue){
    queue=shuffleOn?shuffleArr([...newQueue]):newQueue;
    queueIndex=queue.findIndex(s=>s.id===song.id);
    if(queueIndex<0){queue.unshift(song);queueIndex=0;}
  }
  isPlaying=true; syncPlayBtns(); updateMiniPlayer(); highlightRows();
  if(fullPlayerOpen){updateFullPlayer();renderQueueList();}
  document.getElementById("miniPlayer").style.display="block";
  addToRecentlyPlayed(song);
  updateProfileStats();
  enrichCoverFromDeezer(song);
  if(queue.length<15)expandQueueWithGenre(song);

  ytCandidates=[]; ytCandidateIdx=0;
  let ytId=getYtId(song.audioUrl);
  if(!ytId){
    showToast("Buscando en YouTube...");
    try{
      if(song.musicaId){
        const r=await fetch("/api/youtube/"+song.musicaId);
        if(r?.ok){const d=await r.json();if(d.youtubeId){ytId=d.youtubeId;song.audioUrl="yt:"+ytId;ytCandidates=[ytId];}}
      } else {
        const p=new URLSearchParams({artist:song.artistName||"",title:song.title||""});
        const r=await fetch("/api/youtube-search-multi?"+p);
        if(r?.ok){const d=await r.json();if(d.youtubeIds&&d.youtubeIds.length){ytCandidates=d.youtubeIds;ytId=ytCandidates[0];song.audioUrl="yt:"+ytId;}}
      }
    }catch{}
  } else {
    // fetch extra candidates in background for fallback
    if(!song.musicaId){
      const p=new URLSearchParams({artist:song.artistName||"",title:song.title||""});
      fetch("/api/youtube-search-multi?"+p).then(r=>r.ok?r.json():null).then(d=>{if(d?.youtubeIds?.length)ytCandidates=d.youtubeIds;}).catch(()=>{});
    }
    ytCandidates=[ytId];
  }
  if(ytId){
    const load=()=>{
      if(ytReady&&ytPlayer){
        ytPlayer.loadVideoById(ytId);
        // Auto-show video whenever full player is open
        if(fullPlayerOpen) setTimeout(()=>setPlayerMode(playerMode),600);
      } else setTimeout(load,300);
    };
    load();
  } else {
    showToast("Audio no disponible en YouTube");
    isPlaying=false; syncPlayBtns(); highlightRows();
  }
}

function shuffleArr(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}

function togglePlay(){
  if(!currentSong||!ytPlayer||!ytReady)return;
  try{isPlaying?ytPlayer.pauseVideo():ytPlayer.playVideo();}catch{}
}
function nextSong(){
  if(!queue.length)return;
  queueIndex=(queueIndex+1)%queue.length;
  playSong(queue[queueIndex],null);
}
function prevSong(){
  if(!queue.length)return;
  if(progress>3){try{ytPlayer.seekTo(0,true);progress=0;}catch{}return;}
  queueIndex=queueIndex-1>=0?queueIndex-1:queue.length-1;
  playSong(queue[queueIndex],null);
}

function addSongToQueue(song){
  if(queue.some(s=>s.id==song.id)){showToast("Ya está en la fila");return;}
  queue.push(song);
  if(queueIndex<0)queueIndex=0;
  showToast("Agregado a la fila ✓");
  updateProfileStats();
  if(fullPlayerOpen)renderQueueList();
}

async function expandQueueWithGenre(song){
  const genre=song.genre||currentGenre;
  if(!genre||genre==="trending")return;
  try{
    const res=await fetch("/api/songs?genre="+genre+"&limit=40");
    if(!res.ok)return;
    const data=await res.json();
    const newSongs=(data.songs||[]).filter(s=>!queue.some(q=>q.id===s.id));
    if(newSongs.length){
      queue.push(...newSongs);
      if(fullPlayerOpen)renderQueueList();
    }
  }catch{}
}

function updateMiniPlayer(){
  if(!currentSong)return;
  document.getElementById("miniTitle").textContent=currentSong.title;
  document.getElementById("miniArtist").textContent=currentSong.artistName;
  if(currentSong.albumCover){
    const img=new Image();
    img.onload=()=>{
      const cur=document.getElementById("miniCover");
      if(cur)cur.outerHTML=\`<img id="miniCover" class="mini-cover" src="\${currentSong.albumCover}" alt="">\`;
    };
    img.onerror=()=>{
      const cur=document.getElementById("miniCover");
      if(cur)cur.outerHTML=\`<div id="miniCover" class="mini-cover-ph">🎵</div>\`;
    };
    img.src=currentSong.albumCover;
  }
  if(fullPlayerOpen)updateFullPlayer();
}

function applyCoverToUI(song, coverUrl){
  // Update the cover image in full player
  const artEl=document.getElementById("fpArt");
  const artPh=document.getElementById("fpArtPh");
  let img=artEl.querySelector("img");
  if(!img){img=document.createElement("img");img.style="width:100%;height:100%;object-fit:cover;display:block;";artPh.style.display="none";artEl.appendChild(img);}
  img.src=coverUrl;
  document.getElementById("fpBgArt").style.backgroundImage=\`url(\${coverUrl})\`;
  // Update mini player cover
  const mini=document.getElementById("miniCover");
  if(mini)mini.outerHTML=\`<img id="miniCover" class="mini-cover" src="\${coverUrl}" alt="">\`;
  // Update any visible row covers for this song
  document.querySelectorAll(\`[data-song-id="\${song.id}"] .row-cover\`).forEach(el=>el.src=coverUrl);
}

async function enrichCoverFromDeezer(song){
  if(!song||!song.artistName||!song.title)return;
  try{
    const p=new URLSearchParams({artist:song.artistName,title:song.title});
    const r=await fetch("/api/deezer-cover?"+p);
    if(!r.ok)return;
    const d=await r.json();
    if(d.cover && d.cover!==song.albumCover){
      song.albumCover=d.cover;
      // Only apply if this song is still the one playing
      if(currentSong&&currentSong.id===song.id){
        applyCoverToUI(song, d.cover);
      }
    }
  }catch{}
}

async function enrichListCovers(songs){
  if(!songs||!songs.length)return;
  // Only enrich songs that need it (musica.com covers or null)
  const needsEnrich=songs.filter(s=>!s.artistName||!s.title?false:
    (!s.albumCover||s.albumCover.includes("musicaimg.com")));
  if(!needsEnrich.length)return;
  // Process in batches of 3 concurrent requests to avoid hammering Deezer
  const CONCURRENCY=3;
  for(let i=0;i<needsEnrich.length;i+=CONCURRENCY){
    const batch=needsEnrich.slice(i,i+CONCURRENCY);
    await Promise.all(batch.map(async song=>{
      try{
        const p=new URLSearchParams({artist:song.artistName,title:song.title});
        const r=await fetch("/api/deezer-cover?"+p);
        if(!r.ok)return;
        const d=await r.json();
        if(!d.cover)return;
        song.albumCover=d.cover;
        // Update all img elements with this song's id in the DOM
        document.querySelectorAll(\`[data-song-id="\${song.id}"] img\`).forEach(el=>{
          el.src=d.cover;
        });
        // If it's the currently playing song, also update player UI
        if(currentSong&&currentSong.id===song.id){
          applyCoverToUI(song,d.cover);
        }
      }catch{}
    }));
  }
}

// ─── Context Menu ──────────────────────────────────────────────────────────────
function openCtxMenu(e,song){
  e.preventDefault(); e.stopPropagation();
  ctxTargetSong=song;
  const menu=document.getElementById("ctxMenu");
  const overlay=document.getElementById("ctxOverlay");
  menu.style.display="block"; overlay.style.display="block";
  // Position near click
  let x=e.clientX, y=e.clientY;
  menu.style.left="-9999px"; menu.style.top="-9999px"; menu.style.display="block";
  const mw=menu.offsetWidth, mh=menu.offsetHeight;
  if(x+mw>window.innerWidth-10) x=window.innerWidth-mw-10;
  if(y+mh>window.innerHeight-10) y=window.innerHeight-mh-10;
  menu.style.left=x+"px"; menu.style.top=y+"px";
  // Update like label
  const likeItem=document.getElementById("ctxLike");
  likeItem.innerHTML=isLiked(song.id)
    ? \`<svg width="15" height="15" fill="#ec4899" stroke="#ec4899" stroke-width="2" viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg> Quitar de Me gusta\`
    : \`<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg> Me gusta\`;
}

function closeCtxMenu(){
  document.getElementById("ctxMenu").style.display="none";
  document.getElementById("ctxOverlay").style.display="none";
  ctxTargetSong=null;
}

document.getElementById("ctxOverlay").addEventListener("click",closeCtxMenu);
document.getElementById("ctxPlay").addEventListener("click",()=>{if(ctxTargetSong)playSong(ctxTargetSong,null);closeCtxMenu();});
document.getElementById("ctxAddQueue").addEventListener("click",()=>{if(ctxTargetSong)addSongToQueue(ctxTargetSong);closeCtxMenu();});
document.getElementById("ctxLike").addEventListener("click",()=>{if(ctxTargetSong)toggleLikeSong(ctxTargetSong);closeCtxMenu();});
document.getElementById("ctxShare").addEventListener("click",()=>{if(ctxTargetSong)openShareModal(ctxTargetSong);closeCtxMenu();});
document.getElementById("ctxRemove").addEventListener("click",()=>{
  if(ctxTargetSong){
    const idx=queue.findIndex(s=>s.id==ctxTargetSong.id);
    if(idx>=0){queue.splice(idx,1);if(queueIndex>=queue.length)queueIndex=queue.length-1;showToast("Quitado de la fila");}
    else showToast("No está en la fila actual");
    if(fullPlayerOpen)renderQueueList();
    updateProfileStats();
  }
  closeCtxMenu();
});

// ─── Share Modal ───────────────────────────────────────────────────────────────
function openShareModal(song){
  const s=song||currentSong;
  if(!s)return;
  document.getElementById("shareTitle").textContent=s.title;
  document.getElementById("shareArtist").textContent=s.artistName;
  const link=\`\${location.origin}/?q=\${encodeURIComponent(s.title+" "+s.artistName)}\`;
  document.getElementById("shareLinkText").textContent=link;
  document.getElementById("shareOverlay").classList.add("open");
}

document.getElementById("shareOverlay").addEventListener("click",e=>{
  if(e.target===e.currentTarget)document.getElementById("shareOverlay").classList.remove("open");
});

function doShare(platform){
  const s=currentSong||ctxTargetSong;
  const text=s?\`🎵 Escuchando "\${s.title}" de \${s.artistName||"?"} en PANCHO MIX\`:"Escucha esto en PANCHO MIX";
  const link=\`\${location.origin}/\`;
  const msg=encodeURIComponent(text+" "+link);
  const urls={
    whatsapp:\`https://wa.me/?text=\${msg}\`,
    telegram:\`https://t.me/share/url?url=\${encodeURIComponent(link)}&text=\${encodeURIComponent(text)}\`,
    twitter:\`https://twitter.com/intent/tweet?text=\${msg}\`,
  };
  if(urls[platform]) window.open(urls[platform],"_blank","noopener");
}

document.getElementById("shareWhatsapp").addEventListener("click",()=>doShare("whatsapp"));
document.getElementById("shareTelegram").addEventListener("click",()=>doShare("telegram"));
document.getElementById("shareTwitter").addEventListener("click",()=>doShare("twitter"));
document.getElementById("shareCopy").addEventListener("click",()=>{
  const link=document.getElementById("shareLinkText").textContent;
  navigator.clipboard.writeText(link).then(()=>showToast("¡Link copiado!")).catch(()=>showToast("Copia: "+link));
});
document.getElementById("shareCopyBtn").addEventListener("click",()=>{
  const link=document.getElementById("shareLinkText").textContent;
  navigator.clipboard.writeText(link).then(()=>showToast("¡Link copiado!")).catch(()=>showToast("Copia: "+link));
  document.getElementById("shareOverlay").classList.remove("open");
});

// ─── EQ Modal ─────────────────────────────────────────────────────────────────
const EQ_PRESETS={
  flat:[0,0,0,0,0],
  bass:[8,5,0,0,0],
  pop:[2,4,6,4,2],
  rock:[5,3,-1,3,5],
  electronic:[6,4,0,4,6],
  vocal:[-2,0,6,4,0],
};

function openEqModal(){
  document.getElementById("eqOverlay").classList.add("open");
}
document.getElementById("eqClose").addEventListener("click",()=>document.getElementById("eqOverlay").classList.remove("open"));
document.getElementById("eqOverlay").addEventListener("click",e=>{if(e.target===e.currentTarget)e.currentTarget.classList.remove("open");});

document.querySelectorAll(".eq-preset").forEach(p=>{
  p.addEventListener("click",()=>{
    document.querySelectorAll(".eq-preset").forEach(x=>x.classList.remove("active"));
    p.classList.add("active");
    const vals=EQ_PRESETS[p.dataset.preset]||[0,0,0,0,0];
    document.querySelectorAll(".eq-slider").forEach((s,i)=>{s.value=vals[i]||0;});
    showToast("Preset: "+p.textContent);
  });
});

document.getElementById("eqVolSlider").addEventListener("input",function(){
  const v=parseInt(this.value);
  document.getElementById("eqVolVal").textContent=v+"%";
  if(ytPlayer&&ytReady)try{ytPlayer.setVolume(v);}catch{}
  const miniVol=document.getElementById("volSlider");
  if(miniVol)miniVol.value=v/100;
});

// ─── Profile Panel ─────────────────────────────────────────────────────────────
document.getElementById("avatarBtn").addEventListener("click",()=>{
  updateProfileStats();
  document.getElementById("profileOverlay").classList.toggle("open");
});
document.getElementById("profileOverlay").addEventListener("click",e=>{
  if(e.target===e.currentTarget)e.currentTarget.classList.remove("open");
});
document.getElementById("profileEqBtn").addEventListener("click",()=>{
  document.getElementById("profileOverlay").classList.remove("open");
  openEqModal();
});
document.getElementById("profileClearBtn").addEventListener("click",()=>{
  recentlyPlayed=[];LS.set("recent",[]);totalPlayed=0;
  showToast("Historial limpiado");
  updateProfileStats();
  document.getElementById("profileOverlay").classList.remove("open");
});

// ─── Mini player events ────────────────────────────────────────────────────────
document.getElementById("miniProgress").addEventListener("click",e=>{
  if(!duration||!ytPlayer||!ytReady)return;
  const r=e.currentTarget.getBoundingClientRect();
  const pct=(e.clientX-r.left)/r.width;
  const t=pct*duration;
  try{ytPlayer.seekTo(t,true);}catch{}
  progress=t;
  document.getElementById("miniProgressFill").style.width=(pct*100)+"%";
  document.getElementById("fpProgFill").style.width=(pct*100)+"%";
});
document.getElementById("volSlider").addEventListener("input",e=>{
  const v=parseFloat(e.target.value)*100;
  if(ytPlayer&&ytReady)try{ytPlayer.setVolume(v);}catch{}
  document.getElementById("eqVolSlider").value=v;
  document.getElementById("eqVolVal").textContent=Math.round(v)+"%";
});
document.getElementById("btnPlay").addEventListener("click",e=>{e.stopPropagation();togglePlay();});
document.getElementById("btnNext").addEventListener("click",e=>{e.stopPropagation();nextSong();});
document.getElementById("btnPrev").addEventListener("click",e=>{e.stopPropagation();prevSong();});

document.getElementById("miniPlayer").addEventListener("click",e=>{
  if(e.target.closest("#btnPlay,#btnNext,#btnPrev,.mini-progress"))return;
  if(currentSong)openFullPlayer();
});

// ─── Full player events ────────────────────────────────────────────────────────
document.getElementById("fpBack").addEventListener("click",closeFullPlayer);
document.getElementById("fpModeAudio").addEventListener("click",()=>{setPlayerMode("audio");localStorage.setItem("playerMode","audio");});
document.getElementById("fpModeVideo").addEventListener("click",()=>{setPlayerMode("video");localStorage.setItem("playerMode","video");});
document.getElementById("fpPlayBtn").addEventListener("click",togglePlay);
document.getElementById("fpPrevBtn").addEventListener("click",prevSong);
document.getElementById("fpNextBtn").addEventListener("click",nextSong);

document.getElementById("fpShuffle").addEventListener("click",function(){
  shuffleOn=!shuffleOn;
  this.classList.toggle("on",shuffleOn);
  if(shuffleOn&&queue.length){
    const cur=queue[queueIndex];
    const rest=queue.filter((_,i)=>i!==queueIndex);
    shuffleArr(rest);
    queue=[cur,...rest];
    queueIndex=0;
    if(fullPlayerOpen)renderQueueList();
  }
  showToast(shuffleOn?"🔀 Aleatorio activado":"Aleatorio desactivado");
});

document.getElementById("fpRepeat").addEventListener("click",()=>{
  repeatMode=(repeatMode+1)%3;
  syncRepeatBtn();
  const msgs=["Repetición desactivada","🔁 Repetir todo","🔂 Repetir una"];
  showToast(msgs[repeatMode]);
});

document.getElementById("fpHeartBtn").addEventListener("click",()=>{
  if(!currentSong)return;
  toggleLikeSong(currentSong);
});

document.getElementById("fpLyricsPill").addEventListener("click",()=>{
  if(currentSong){
    const q=encodeURIComponent(currentSong.title+" "+currentSong.artistName+" letra");
    window.open("https://www.google.com/search?q="+q,"_blank","noopener");
  }
});
document.getElementById("fpQueuePill").addEventListener("click",()=>{
  document.querySelector(".fp-queue").scrollIntoView({behavior:"smooth"});
});

document.getElementById("fpVolSlider").addEventListener("input",function(){
  const vol=parseFloat(this.value);
  try{if(ytPlayer&&ytReady)ytPlayer.setVolume(vol*100);}catch{}
  const miniSlider=document.getElementById("volSlider");
  if(miniSlider)miniSlider.value=vol;
});
document.getElementById("fpShareBtn").addEventListener("click",()=>{
  if(currentSong)openShareModal(currentSong);
});
document.getElementById("fpMoreBtn").addEventListener("click",e=>{
  if(currentSong)openCtxMenu(e,currentSong);
});

document.getElementById("fpProgTrack").addEventListener("click",e=>{
  if(!duration||!ytPlayer||!ytReady)return;
  const r=e.currentTarget.getBoundingClientRect();
  const pct=(e.clientX-r.left)/r.width;
  const t=pct*duration;
  try{ytPlayer.seekTo(t,true);}catch{}
  progress=t;
  document.getElementById("fpProgFill").style.width=(pct*100)+"%";
  document.getElementById("miniProgressFill").style.width=(pct*100)+"%";
  document.getElementById("fpCurrent").textContent=fmt(t);
  document.getElementById("progCurrent").textContent=fmt(t);
});

// Queue chips — filter queue list
document.querySelectorAll(".fp-q-chip").forEach(chip=>{
  chip.addEventListener("click",()=>{
    document.querySelectorAll(".fp-q-chip").forEach(c=>c.classList.remove("active"));
    chip.classList.add("active");
    const filter=chip.textContent.trim();
    const rows=document.querySelectorAll(".fp-q-row");
    rows.forEach((row,i)=>{
      if(filter==="Todos"){row.style.display="";}
      else if(filter==="Canciones conocidas"){row.style.display=i%2===0?"":"none";}
      else{row.style.display=i%2!==0?"":"none";}
    });
  });
});

// Save queue to localStorage
document.getElementById("fpQueueSaveBtn").addEventListener("click",()=>{
  if(!queue.length){showToast("La fila está vacía");return;}
  LS.set("savedQueue",queue);
  showToast("Fila guardada ("+queue.length+" canciones) ✓");
});

// Swipe down to close full player (only when scrolled to top)
document.getElementById("fullPlayer").addEventListener("touchstart",e=>{touchStartY=e.touches[0].clientY;},{passive:true});
document.getElementById("fullPlayer").addEventListener("touchend",e=>{
  const content=document.getElementById("fpContent")||document.querySelector(".fp-content");
  const atTop=!content||content.scrollTop<10;
  const dy=e.changedTouches[0].clientY-touchStartY;
  if(dy>80&&e.changedTouches[0].clientY<200&&atTop)closeFullPlayer();
},{passive:true});

// ─── Keyboard shortcuts ────────────────────────────────────────────────────────
let kbdTimeout;
function showKbdHint(){
  const h=document.getElementById("kbdHint");
  h.classList.add("show");
  clearTimeout(kbdTimeout);
  kbdTimeout=setTimeout(()=>h.classList.remove("show"),3000);
}

document.addEventListener("keydown",e=>{
  if(e.target.tagName==="INPUT"||e.target.tagName==="TEXTAREA")return;
  if(e.key===" "||e.code==="Space"){e.preventDefault();togglePlay();showKbdHint();}
  else if(e.key==="ArrowRight"){nextSong();showKbdHint();}
  else if(e.key==="ArrowLeft"){prevSong();showKbdHint();}
  else if(e.key.toLowerCase()==="l"){if(currentSong)toggleLikeSong(currentSong);showKbdHint();}
  else if(e.key.toLowerCase()==="f"){if(currentSong){fullPlayerOpen?closeFullPlayer():openFullPlayer();}}
  else if(e.key==="Escape"){
    closeCtxMenu();
    document.getElementById("shareOverlay").classList.remove("open");
    document.getElementById("eqOverlay").classList.remove("open");
    document.getElementById("profileOverlay").classList.remove("open");
    if(fullPlayerOpen)closeFullPlayer();
  }
});

// ─── HTML helpers ──────────────────────────────────────────────────────────────
const esc=s=>String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
function showToast(msg){const t=document.getElementById("toast");t.textContent=msg;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),3000);}
function fmtPlays(n){n=n||Math.floor(Math.random()*90+10)*1000000;if(n>=1e9)return(n/1e9).toFixed(1)+"B";if(n>=1e6)return Math.round(n/1e6)+" M";if(n>=1e3)return Math.round(n/1e3)+"K";return n;}

// ─── Song row HTML ─────────────────────────────────────────────────────────────
function songRowHtml(s,i){
  const lk=isLiked(s.id);
  return \`<div class="song-row" data-id="\${s.id}" data-song-id="\${s.id}" data-index="\${i}">
    \${s.albumCover?\`<img class="row-cover" src="\${esc(s.albumCover)}" loading="lazy" onerror="this.outerHTML='<div class=row-cover-ph>♪</div>'">\`:\`<div class="row-cover-ph">♪</div>\`}
    <svg class="row-verify" width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
    <div class="row-info">
      <div class="row-title">\${esc(s.title)}</div>
      <div class="row-sub">\${esc(s.artistName)} · \${fmtPlays(s.plays)} reproducciones</div>
    </div>
    <div class="row-right">
      \${lk?\`<div class="liked-badge">♥</div>\`:""}
      <div class="eq-bars" style="display:none"><span></span><span></span><span></span></div>
      <button class="row-dots" data-index="\${i}">⋯</button>
    </div>
  </div>\`;
}

// ─── RENDER VIEWS ──────────────────────────────────────────────────────────────
function renderHome(songs, gridSongs){
  if(!songs||!songs.length){renderEmpty("No hay canciones disponibles");return;}
  const top=songs.slice(0,8);
  const grid=gridSongs||songs.slice(8,20);
  const horiz=songs.slice(0,10);

  const recentHtml=recentlyPlayed.length>0?\`
    <div class="sec">
      <div class="sec-hdr"><div class="sec-title">Escuchado recientemente</div></div>
      <div class="hscroll">\${recentlyPlayed.slice(0,8).map((s,i)=>\`
        <div class="hcard" data-recent-index="\${i}">
          <div class="hcard-img">
            \${s.albumCover?\`<img src="\${esc(s.albumCover)}" loading="lazy" onerror="this.style.display='none'">\`:\`<div class="hcard-img-ph">🎵</div>\`}
          </div>
          <div class="hcard-title">\${esc(s.title)}</div>
          <div class="hcard-sub">\${esc(s.artistName)}</div>
        </div>
      \`).join("")}</div>
    </div>\`:"";

  const paraTiPlaylists=buildParaTiPlaylists(songs);

  const content=document.getElementById("mainContent");
  content.innerHTML=\`
    \${recentHtml}
    <div class="sec" id="paraTiSec">
      <div class="sec-hdr">
        <div class="sec-title" style="font-size:1.15rem;font-weight:900;letter-spacing:-.03em">Para ti ✨</div>
        <button class="sec-action" id="diceBtn" style="display:flex;align-items:center;gap:6px;font-size:.78rem;">🎲 Sorpréndeme</button>
      </div>
      <div class="pt-carousel" id="ptCarousel">
        \${paraTiPlaylists.map((pl,i)=>\`
          <div class="pt-card" data-pt-index="\${i}" style="--pt-grad:\${pl.gradient}">
            <div class="pt-card-bg"></div>
            <div class="pt-card-glass"></div>
            <div class="pt-card-shine"></div>
            <div class="pt-cover-icon" id="ptCover\${i}">\${pl.icon}</div>
            <div class="pt-card-body">
              <div class="pt-card-name">\${esc(pl.name)}</div>
              <div class="pt-card-desc">\${esc(pl.desc)}</div>
              <div class="pt-card-tag">\${pl.tag}</div>
            </div>
          </div>
        \`).join("")}
      </div>
    </div>
    <div class="sec">
      <div class="sec-hdr"><div class="sec-title">Volver a escuchar</div></div>
      <div class="album-grid">\${grid.slice(0,6).map((s,i)=>\`
        <div class="album-card" data-song-id="\${s.id}" data-index="\${top.length+i}">
          \${s.albumCover?\`<img src="\${esc(s.albumCover)}" loading="lazy" onerror="this.style.display='none'">\`:\`<div class="album-card-ph">🎵</div>\`}
          <div class="album-card-overlay"><div class="album-card-title">\${esc(s.title)}</div></div>
          <div class="album-card-arrow">▶</div>
        </div>
      \`).join("")}</div>
    </div>
    <div class="sec" style="padding-bottom:24px">
      <div class="sec-hdr">
        <div class="sec-title">Álbumes</div>
        <button class="sec-action" id="refreshAlbumsBtn" style="display:flex;align-items:center;gap:5px">↺ Actualizar</button>
      </div>
      <div class="nov-scroll" id="novAlbumsScroll">
        \${Array.from({length:8}).map(()=>\`
          <div class="nov-alb-skel">
            <div class="nov-alb-skel-cover"></div>
            <div class="nov-alb-skel-line" style="width:80%"></div>
            <div class="nov-alb-skel-line"></div>
          </div>
        \`).join("")}
      </div>
    </div>
  \`;

  content.querySelectorAll(".song-row").forEach(row=>{
    row.addEventListener("click",()=>{const i=parseInt(row.dataset.index);playSong(top[i],top);});
    row.querySelector(".row-dots").addEventListener("click",e=>{e.stopPropagation();openCtxMenu(e,top[parseInt(row.dataset.index)]);});
  });
  content.querySelectorAll(".album-card").forEach(card=>{
    card.addEventListener("click",()=>{const i=parseInt(card.dataset.index)-top.length;playSong(grid[i],grid);});
  });
  const refreshAlbumsBtn=content.querySelector("#refreshAlbumsBtn");
  if(refreshAlbumsBtn)refreshAlbumsBtn.addEventListener("click",()=>{
    albumsCache2=null;
    loadNovAlbums(content.querySelector("#novAlbumsScroll"),true);
  });

  content.querySelectorAll(".hcard[data-index]").forEach(card=>{
    card.addEventListener("click",()=>{const i=parseInt(card.dataset.index);playSong(horiz[i],horiz);});
  });
  content.querySelectorAll(".hcard[data-recent-index]").forEach(card=>{
    card.addEventListener("click",()=>{const i=parseInt(card.dataset["recentIndex"]);playSong(recentlyPlayed[i],recentlyPlayed);});
  });
  content.querySelectorAll(".chip").forEach(chip=>{
    chip.addEventListener("click",()=>loadGenre(chip.dataset.genre));
  });
  const playAllBtn=content.querySelector("#playAllBtn");
  if(playAllBtn)playAllBtn.addEventListener("click",()=>{if(top.length)playSong(top[0],top);});
  const shuffleBtn=content.querySelector("#shuffleAllBtn");
  if(shuffleBtn)shuffleBtn.addEventListener("click",()=>{
    if(!songs.length)return;
    shuffleOn=true;
    document.getElementById("fpShuffle").classList.add("on");
    const arr=shuffleArr([...songs]);
    playSong(arr[0],arr);
    showToast("🔀 Reproduciendo en aleatorio");
  });

  const diceBtnInline=content.querySelector("#diceBtn");
  if(diceBtnInline)diceBtnInline.addEventListener("click",()=>playDiceSong());

  content.querySelectorAll(".pt-card").forEach(card=>{
    const i=parseInt(card.dataset.ptIndex);
    card.addEventListener("click",()=>{
      const pl=_paraTimePlaylists[i];
      if(pl&&pl.songs&&pl.songs.length){
        const playlist={
          name:pl.name,desc:pl.desc,icon:pl.icon,
          genre:pl.genres?pl.genres[0]:"trending",color:pl.gradient,id:"parati-"+i
        };
        renderPlaylistPage(playlist,pl.songs,null);
      }
    });
  });

  loadParaTiCovers(paraTiPlaylists,content);
  loadParaTiSongsAsync(content);
  loadNovAlbums(content.querySelector("#novAlbumsScroll"));

  highlightRows();
  enrichListCovers(songs);
}

const RECENT_SEARCHES_KEY="pancho_recent_searches";
function getRecentSearches(){try{return JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY)||"[]");}catch{return[];}}
function saveRecentSearch(q){if(!q||q.length<2)return;let r=getRecentSearches().filter(x=>x!==q);r.unshift(q);r=r.slice(0,8);localStorage.setItem(RECENT_SEARCHES_KEY,JSON.stringify(r));}
function removeRecentSearch(q){const r=getRecentSearches().filter(x=>x!==q);localStorage.setItem(RECENT_SEARCHES_KEY,JSON.stringify(r));renderSearchPlaceholder();}
function clearAllRecents(){localStorage.removeItem(RECENT_SEARCHES_KEY);renderSearchPlaceholder();}

const GENRE_CARDS=[
  {id:"pop",label:"Pop",color:"linear-gradient(135deg,#E91E8C,#9C27B0)",icon:"🎤",genre:"pop"},
  {id:"reggaeton",label:"Reggaeton",color:"linear-gradient(135deg,#FF6D00,#E91E63)",icon:"🔥",genre:"reggaeton"},
  {id:"rock",label:"Rock",color:"linear-gradient(135deg,#546E7A,#212121)",icon:"🎸",genre:"rock"},
  {id:"latina",label:"Latina",color:"linear-gradient(135deg,#00897B,#2E7D32)",icon:"💃",genre:"latina"},
  {id:"hiphop",label:"Hip-Hop",color:"linear-gradient(135deg,#F57F17,#BF360C)",icon:"🎧",genre:"hip-hop"},
  {id:"electronica",label:"Electrónica",color:"linear-gradient(135deg,#1565C0,#6A1B9A)",icon:"⚡",genre:"electronica"},
  {id:"baladas",label:"Baladas",color:"linear-gradient(135deg,#AD1457,#4527A0)",icon:"💜",genre:"pop"},
  {id:"rnb",label:"R&B",color:"linear-gradient(135deg,#6A1B9A,#1A237E)",icon:"🎶",genre:"hip-hop"},
  {id:"trap",label:"Trap",color:"linear-gradient(135deg,#263238,#546E7A)",icon:"🔱",genre:"hip-hop"},
  {id:"salsa",label:"Salsa",color:"linear-gradient(135deg,#B71C1C,#E65100)",icon:"🥁",genre:"latina"},
  {id:"indie",label:"Indie",color:"linear-gradient(135deg,#33691E,#1B5E20)",icon:"🌿",genre:"rock"},
  {id:"metal",label:"Metal",color:"linear-gradient(135deg,#37474F,#880E4F)",icon:"🤘",genre:"rock"},
];

function renderSearchPlaceholder(){
  const area=document.getElementById("searchResults");
  if(!area)return;
  const recents=getRecentSearches();
  const recHtml=recents.length?\`
    <div class="search-recents-wrap">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <div class="search-section-title" style="margin-bottom:0">Recientes</div>
        <button onclick="clearAllRecents()" style="background:none;border:none;cursor:pointer;color:rgba(168,85,247,.85);font-size:.8rem;font-weight:600;padding:4px 8px;border-radius:8px;transition:background .15s" onmouseover="this.style.background='rgba(168,85,247,.12)'" onmouseout="this.style.background='none'">Limpiar</button>
      </div>
      <div class="search-recent-list">
        \${recents.map(r=>\`
          <div class="search-recent-item" onclick="fillSearch('\${esc(r)}')">
            <svg class="search-recent-icon" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            \${esc(r)}
            <button class="search-recent-del" onclick="event.stopPropagation();removeRecentSearch('\${esc(r)}')" title="Quitar">✕</button>
          </div>
        \`).join("")}
      </div>
    </div>\`:"";
  area.innerHTML=\`
    \${recHtml}
    <div class="search-section-title">Explorar todo</div>
    <div class="genre-grid">
      \${GENRE_CARDS.map((g,i)=>\`
        <div class="genre-card" onclick="openCategoryPage(GENRE_CARDS[\${i}])" style="--gc:\${g.color}">
          <div class="genre-card-bg"></div>
          <div class="genre-card-shine"></div>
          <span class="genre-card-icon">\${g.icon}</span>
          <div class="genre-card-label"><span>\${esc(g.label)}</span></div>
        </div>
      \`).join("")}
    </div>
  \`;
}

function fillSearch(q){
  const inp=document.getElementById("searchViewInput");
  if(!inp)return;
  inp.value=q;inp.focus();
  const clearBtn=document.getElementById("searchClearBtn");
  if(clearBtn)clearBtn.style.display=q?"flex":"none";
  clearTimeout(searchTimeout);
  searchTimeout=setTimeout(()=>doSearch(q),100);
}

function renderSearch(){
  const content=document.getElementById("mainContent");
  content.innerHTML=\`
    <div class="explore-top">
      <div class="search-bar-wrap" id="searchBarWrap">
        <svg width="20" height="20" fill="none" stroke="rgba(255,255,255,.45)" stroke-width="2.2" viewBox="0 0 24 24" style="flex-shrink:0"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <input type="text" id="searchViewInput" placeholder="¿Qué quieres escuchar?" autocomplete="off" spellcheck="false">
        <button id="searchClearBtn" class="search-clear-btn" style="display:none" title="Borrar">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.8" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>
    <div id="searchResults"></div>
  \`;
  renderSearchPlaceholder();
  const inp=content.querySelector("#searchViewInput");
  const clearBtn=content.querySelector("#searchClearBtn");
  inp.addEventListener("input",e=>{
    const q=e.target.value.trim();
    clearBtn.style.display=q?"flex":"none";
    clearTimeout(searchTimeout);
    if(!q){renderSearchPlaceholder();return;}
    searchTimeout=setTimeout(()=>doSearch(q),420);
  });
  inp.addEventListener("keydown",e=>{
    if(e.key==="Enter"){const q=inp.value.trim();if(q){clearTimeout(searchTimeout);doSearch(q);}}
    if(e.key==="Escape"){inp.value="";clearBtn.style.display="none";renderSearchPlaceholder();}
  });
  clearBtn.addEventListener("click",()=>{inp.value="";clearBtn.style.display="none";inp.focus();renderSearchPlaceholder();});
  inp.focus();
}

function fmtFans(n){
  if(!n)return"";
  if(n>=1000000)return(n/1000000).toFixed(1).replace(/\.0$/,"")+" M oyentes mensuales";
  if(n>=1000)return(n/1000).toFixed(0)+" K oyentes mensuales";
  return n.toLocaleString()+" oyentes mensuales";
}

function renderResults(songs, query, artist){
  const area=document.getElementById("searchResults");
  if(!songs||!songs.length){
    area.innerHTML=\`<div class="search-empty-state">
      <div class="search-empty-icon">🎵</div>
      <div class="search-empty-text">Sin resultados para "<strong>\${esc(query)}</strong>"<br><span style="font-size:.8rem;margin-top:6px;display:block">Intenta con otro nombre o artista</span></div>
    </div>\`;
    return;
  }

  // ── Artist view ──────────────────────────────────────────────────────────────
  if(artist){
    const initials=(artist.name||"?").split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase();
    const avatarHtml=artist.image
      ?\`<img class="artist-avatar" src="\${esc(artist.image)}" loading="lazy" onerror="this.outerHTML='<div class=artist-avatar-ph>\${esc(initials)}</div>'">\`
      :\`<div class="artist-avatar-ph">\${esc(initials)}</div>\`;
    const fansHtml=artist.fans?\`<div class="artist-fans">\${esc(fmtFans(artist.fans))}</div>\`:"";
    const songRows=songs.map((s,i)=>{
      const cover=s.albumCover?\`<img class="search-result-cover" src="\${esc(s.albumCover)}" loading="lazy" onerror="this.outerHTML='<div class=search-result-cover-ph>🎵</div>'">\`:\`<div class="search-result-cover-ph">🎵</div>\`;
      const dur=s.duration?Math.floor(s.duration/60)+":"+(s.duration%60<10?"0":"")+s.duration%60:"";
      const active=currentSong&&currentSong.id===s.id?"active-row":"";
      return \`<div class="search-result-row \${active}" data-index="\${i}">
        \${cover}
        <div class="search-result-info">
          <div class="search-result-title">\${esc(s.title)}</div>
          <div class="search-result-meta">Canción · \${esc(s.artistName)}\${dur?" · "+dur:""}</div>
        </div>
        <div class="search-result-actions">
          <button class="search-result-dots" title="Más opciones">⋮</button>
        </div>
      </div>\`;
    }).join("");
    const skelAlbums=Array.from({length:5}).map(()=>\`
      <div class="sr-alb-skel">
        <div class="sr-alb-skel-cover"></div>
        <div class="sr-alb-skel-line" style="width:80%"></div>
        <div class="sr-alb-skel-line" style="width:55%"></div>
      </div>\`).join("");
    const skelPl=Array.from({length:4}).map(()=>\`
      <div class="sr-alb-skel">
        <div class="sr-alb-skel-cover"></div>
        <div class="sr-alb-skel-line" style="width:80%"></div>
        <div class="sr-alb-skel-line" style="width:55%"></div>
      </div>\`).join("");
    area.innerHTML=\`
      <div class="artist-card">
        \${avatarHtml}
        <div class="artist-name">\${esc(artist.name)}</div>
        \${fansHtml}
        <div class="artist-btns">
          <button class="artist-btn-shuffle" id="artistBtnShuffle">
            <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>
            Aleatorio
          </button>
          <button class="artist-btn-radio" id="artistBtnRadio">
            <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49"/><path d="M7.76 7.76a6 6 0 0 0 0 8.49"/><path d="M20.07 4.93a10 10 0 0 1 0 14.14"/><path d="M3.93 4.93a10 10 0 0 0 0 14.14"/></svg>
            Radio
          </button>
        </div>
      </div>
      <div class="sr-sec">
        <div class="sr-sec-hdr"><div class="sr-sec-title">Álbumes</div></div>
        <div class="sr-alb-scroll" id="srAlbScroll">\${skelAlbums}</div>
      </div>
      <div class="sr-sec">
        <div class="sr-sec-hdr"><div class="sr-sec-title">Playlists</div></div>
        <div class="sr-pl-scroll" id="srPlScroll">\${skelPl}</div>
      </div>
      <div class="sr-sec">
        <div class="sr-sec-hdr"><div class="sr-sec-title">Canciones populares</div></div>
        \${songRows}
      </div>
      <div style="padding-bottom:36px"></div>
    \`;
    area.querySelector(".artist-card").addEventListener("click",e=>{
      if(e.target.closest("#artistBtnShuffle")||e.target.closest("#artistBtnRadio"))return;
      openArtistProfile(artist);
    });
    area.querySelector("#artistBtnShuffle").addEventListener("click",e=>{
      e.stopPropagation();
      const shuffled=[...songs].sort(()=>Math.random()-.5);
      playSong(shuffled[0],shuffled);
    });
    area.querySelector("#artistBtnRadio").addEventListener("click",e=>{e.stopPropagation();playSong(songs[0],songs);});
    area.querySelectorAll(".search-result-row").forEach(row=>{
      const i=parseInt(row.dataset.index);
      row.addEventListener("click",()=>playSong(songs[i],songs));
      row.querySelector(".search-result-dots").addEventListener("click",e=>{e.stopPropagation();openCtxMenu(e,songs[i]);});
    });
    highlightRows();
    enrichListCovers(songs);
    loadArtistSearchExtras(artist,songs,area);
    return;
  }

  // ── Normal search results ────────────────────────────────────────────────────
  const top=songs[0];
  const rest=songs.slice(1);
  const heroImg=top.albumCover
    ?\`<img class="sr-hero-cover" src="\${esc(top.albumCover)}" loading="lazy" onerror="this.outerHTML='<div class=sr-hero-cover-ph>🎵</div>'">\`
    :\`<div class="sr-hero-cover-ph">🎵</div>\`;
  area.innerHTML=\`
    <div class="search-results-header">
      <div class="search-results-count">\${songs.length} resultado\${songs.length!==1?"s":""} · "\${esc(query)}"</div>
    </div>
    <div class="sr-hero" data-index="0">
      \${heroImg}
      <div class="sr-hero-info">
        <div class="sr-hero-tag">Mejor resultado</div>
        <div class="sr-hero-title">\${esc(top.title)}</div>
        <div class="sr-hero-meta">Canción · \${esc(top.artistName)}</div>
        <div class="sr-hero-btns">
          <button class="sr-hero-play"><svg width="13" height="13" fill="currentColor" viewBox="0 0 24 24" style="flex-shrink:0"><polygon points="5 3 19 12 5 21 5 3"/></svg>Reproducir</button>
          <button class="sr-hero-more">⋯ Opciones</button>
        </div>
      </div>
    </div>
    \${rest.length?\`<div class="sr-list-label">Canciones</div>\`:""}
    \${rest.map((s,i)=>{
      const cover=s.albumCover?\`<img class="search-result-cover" src="\${esc(s.albumCover)}" loading="lazy" onerror="this.outerHTML='<div class=search-result-cover-ph>🎵</div>'">\`:\`<div class="search-result-cover-ph">🎵</div>\`;
      const dur=s.duration?Math.floor(s.duration/60)+":"+(s.duration%60<10?"0":"")+s.duration%60:"";
      const active=currentSong&&currentSong.id===s.id?"active-row":"";
      return \`<div class="search-result-row \${active}" data-song-id="\${s.id}" data-index="\${i+1}">
        \${cover}
        <div class="search-result-info">
          <div class="search-result-title">\${esc(s.title)}</div>
          <div class="search-result-meta">Canción · \${esc(s.artistName)}\${dur?" · "+dur:""}</div>
        </div>
        <div class="search-result-actions">
          <button class="search-result-dots" title="Más opciones">⋮</button>
        </div>
      </div>\`;
    }).join("")}
    <div style="padding-bottom:36px"></div>
  \`;
  const hero=area.querySelector(".sr-hero");
  hero.addEventListener("click",()=>playSong(songs[0],songs));
  hero.querySelector(".sr-hero-play").addEventListener("click",e=>{e.stopPropagation();playSong(songs[0],songs);});
  hero.querySelector(".sr-hero-more").addEventListener("click",e=>{e.stopPropagation();openCtxMenu(e,songs[0]);});
  area.querySelectorAll(".search-result-row").forEach(row=>{
    const i=parseInt(row.dataset.index);
    row.addEventListener("click",()=>playSong(songs[i],songs));
    row.querySelector(".search-result-dots").addEventListener("click",e=>{e.stopPropagation();openCtxMenu(e,songs[i]);});
  });
  highlightRows();
  enrichListCovers(songs);
}

// ─── Trending page ─────────────────────────────────────────────────────────────
async function renderTrending(){
  currentView="trending";
  renderLoading("Cargando lo más trending...");
  try{
    const res=await fetch("/api/trending");
    const data=await res.json();
    renderTrendingPage(data.songs||[],data.byGenre||{});
  }catch(e){renderEmpty("Error al cargar trending: "+e.message);}
}

function renderTrendingPage(songs,byGenre){
  const content=document.getElementById("mainContent");
  const top10=songs.slice(0,10);
  const GENRE_META={
    pop:{label:"Pop",icon:"🎵",color:"#ec4899"},
    reggaeton:{label:"Reggaeton",icon:"🎤",color:"#f59e0b"},
    latina:{label:"Latina",icon:"💃",color:"#ef4444"},
    "hip-hop":{label:"Hip-Hop",icon:"🎧",color:"#818cf8"},
    rock:{label:"Rock",icon:"🎸",color:"#94a3b8"},
    electronica:{label:"Electrónica",icon:"⚡",color:"#22d3ee"},
  };

  // Unique artists (up to 14) for the artists row
  const artistNames=[...new Set(songs.map(s=>s.artistName).filter(Boolean))].slice(0,14);
  // Gradient palette for avatar placeholders
  const GRADIENTS=["linear-gradient(135deg,#a855f7,#6366f1)","linear-gradient(135deg,#f59e0b,#ef4444)","linear-gradient(135deg,#22d3ee,#059669)","linear-gradient(135deg,#ec4899,#a855f7)","linear-gradient(135deg,#818cf8,#3b82f6)","linear-gradient(135deg,#dc2626,#ea580c)"];

  content.innerHTML=\`
    <div class="trend-page-hdr">
      <div class="trend-page-title">🔥 Trending</div>
      <div class="trend-page-sub">Lo más escuchado ahora mismo</div>
    </div>

    <!-- Artistas populares -->
    <div class="sec">
      <div class="sec-hdr"><div class="sec-title">👤 Artistas populares</div></div>
      <div class="trend-artists-scroll" id="trendArtistsRow">
        \${artistNames.map((name,i)=>\`
          <div class="trend-artist-chip" data-aname="\${esc(name)}" data-ai="\${i}">
            <div class="tac-avatar" style="background:\${GRADIENTS[i%GRADIENTS.length]}" id="tac-\${i}">
              \${esc(name.charAt(0).toUpperCase())}
            </div>
            <div class="tac-name">\${esc(name.split(" ")[0])}</div>
          </div>
        \`).join("")}
      </div>
    </div>

    <!-- Top 10 -->
    <div class="sec">
      <div class="sec-hdr">
        <div class="sec-title">Top 10 Global</div>
        <button class="sec-action" id="trendPlayAll">▶ Reproducir todo</button>
      </div>
      <div class="song-list">
        \${top10.map((s,i)=>\`
          <div class="trend-row" data-ti="\${i}">
            <div class="trend-rank \${i<3?"trend-rank-top":""}">\${i+1}</div>
            <div class="trend-cover">
              \${s.albumCover?\`<img src="\${esc(s.albumCover)}" loading="lazy" onerror="this.style.display='none'">\`:\`<div class="trend-cover-ph">🎵</div>\`}
              \${i===0?\`<div class="trend-fire">🔥</div>\`:""}
            </div>
            <div class="trend-info">
              <div class="trend-title">\${esc(s.title)}</div>
              <div class="trend-artist">\${esc(s.artistName)}</div>
            </div>
            <div class="trend-badge">\${i===0?"🏆":i<3?"⭐":""}</div>
            <button class="row-dots" data-ti="\${i}">⋯</button>
          </div>
        \`).join("")}
      </div>
    </div>

    <!-- Genre sections -->
    \${Object.entries(byGenre).filter(([,s])=>s&&s.length).map(([genre,gs])=>{
      const meta=GENRE_META[genre]||{label:genre,icon:"🎵",color:"#a855f7"};
      return \`
        <div class="sec">
          <div class="sec-hdr">
            <div class="sec-title" style="display:flex;align-items:center;gap:8px">
              <span style="width:28px;height:28px;border-radius:50%;background:\${meta.color}33;display:inline-flex;align-items:center;justify-content:center;font-size:.85rem">\${meta.icon}</span>
              \${meta.label}
            </div>
            <button class="sec-action tg-play-all" data-genre="\${genre}">▶ Reproducir</button>
          </div>
          <div class="nov-scroll">
            \${gs.slice(0,8).map((s,i)=>\`
              <div class="nov-card tg-card" data-genre="\${genre}" data-ti="\${i}" style="flex-shrink:0;width:140px">
                <div class="nov-card-cover">
                  \${s.albumCover?\`<img src="\${esc(s.albumCover)}" loading="lazy" onerror="this.style.display='none'">\`:\`<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:2rem">\${meta.icon}</div>\`}
                  <div class="nov-card-play">▶</div>
                </div>
                <div class="nov-card-title">\${esc(s.title)}</div>
                <div class="nov-card-sub">\${esc(s.artistName)}</div>
              </div>
            \`).join("")}
          </div>
        </div>
      \`;
    }).join("")}
    <div style="height:24px"></div>
  \`;

  // ── Artist photo loader (async, non-blocking) ──
  if(artistNames.length){
    fetch("/api/artist-photos?names="+encodeURIComponent(artistNames.join(",")))
      .then(r=>r.json())
      .then(data=>{
        (data.artists||[]).forEach((a,i)=>{
          if(!a.image)return;
          const av=content.querySelector("#tac-"+i);
          if(av) av.innerHTML=\`<img src="\${esc(a.image)}" loading="lazy" onerror="this.parentElement.innerHTML=this.parentElement.dataset.init">\`;
        });
      }).catch(()=>{});
  }

  // ── Artist chip clicks → artist profile ──
  content.querySelectorAll(".trend-artist-chip").forEach(chip=>{
    chip.addEventListener("click",async()=>{
      const name=chip.dataset.aname;
      renderLoading("Cargando artista...");
      try{
        const r=await fetch("/api/artist-profile?name="+encodeURIComponent(name));
        const data=await r.json();
        renderArtistProfile(data.artist||{name,image:null,fans:0},data.tracks||[]);
      }catch(e){renderEmpty("Error al cargar artista");}
    });
  });

  // ── Top 10 clicks ──
  content.querySelectorAll(".trend-row").forEach(row=>{
    const i=parseInt(row.dataset.ti);
    row.addEventListener("click",()=>playSong(top10[i],top10));
    row.querySelector(".row-dots")?.addEventListener("click",e=>{
      e.stopPropagation();openCtxMenu(e,top10[i]);
    });
  });

  // ── Play all top 10 ──
  content.querySelector("#trendPlayAll")?.addEventListener("click",()=>{
    if(top10.length) playSong(top10[0],songs);
  });

  // ── Genre section cards ──
  content.querySelectorAll(".tg-card").forEach(card=>{
    card.addEventListener("click",()=>{
      const gs=byGenre[card.dataset.genre]||[];
      const i=parseInt(card.dataset.ti);
      if(gs[i]) playSong(gs[i],gs);
    });
  });

  // ── Genre play all ──
  content.querySelectorAll(".tg-play-all").forEach(btn=>{
    btn.addEventListener("click",()=>{
      const gs=byGenre[btn.dataset.genre]||[];
      if(gs.length) playSong(gs[0],gs);
    });
  });

  enrichListCovers(songs);
}

function renderLibrary(){
  const content=document.getElementById("mainContent");
  if(!likedSongs.length){
    content.innerHTML=\`
      <div class="lib-header"><div class="sec-title">Tu Biblioteca</div></div>
      <div class="lib-empty-cta">
        <div class="lib-empty-icon">💿</div>
        <div class="lib-empty-text">Aún no tienes canciones guardadas.<br>Presiona ♥ en cualquier canción para guardarla.</div>
        <button class="lib-empty-btn" onclick="setView('home')">Explorar música</button>
      </div>
    \`;
    return;
  }
  content.innerHTML=\`
    <div class="sec-hdr" style="margin-bottom:16px">
      <div class="sec-title">Me gusta · \${likedSongs.length}</div>
      <button class="sec-action" id="libPlayAllBtn">▶ Reproducir todo</button>
    </div>
    <div class="song-list">\${likedSongs.map((s,i)=>songRowHtml(s,i)).join("")}</div>
    <div style="padding-bottom:24px"></div>
  \`;
  content.querySelectorAll(".song-row").forEach(row=>{
    row.addEventListener("click",()=>{const i=parseInt(row.dataset.index);playSong(likedSongs[i],likedSongs);});
    row.querySelector(".row-dots").addEventListener("click",e=>{e.stopPropagation();openCtxMenu(e,likedSongs[parseInt(row.dataset.index)]);});
  });
  content.querySelector("#libPlayAllBtn")?.addEventListener("click",()=>{if(likedSongs.length)playSong(likedSongs[0],likedSongs);});
  highlightRows();
  enrichListCovers(likedSongs);
}

function renderEmpty(msg){
  document.getElementById("mainContent").innerHTML=\`<div class="empty-msg"><span>\${esc(msg)}</span></div>\`;
}
function renderLoading(msg="Cargando..."){
  document.getElementById("mainContent").innerHTML=\`<div class="loading-msg"><div class="spinner"></div>\${esc(msg)}</div>\`;
}

// ─── Data loading ──────────────────────────────────────────────────────────────
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
  if(!q||q.length<2){renderSearchPlaceholder();return;}
  const area=document.getElementById("searchResults");
  if(area)area.innerHTML=\`<div class="loading-msg"><div class="spinner"></div>Buscando "<strong>\${esc(q)}</strong>"...</div>\`;
  try{
    const res=await fetch("/api/search?q="+encodeURIComponent(q));
    const data=await res.json();
    saveRecentSearch(q);
    renderResults(data.songs||[],q,data.artist||null);
  }catch(e){if(area)area.innerHTML=\`<div class="search-empty-state"><div class="search-empty-icon">⚠️</div><div class="search-empty-text">Error al buscar</div></div>\`;}
}

function syncChips(genre){
  document.querySelectorAll(".chip").forEach(c=>c.classList.toggle("active",c.dataset.genre===genre));
}

// ─── Artist Search Extras (Albums + Playlists) ────────────────────────────────
async function loadArtistSearchExtras(artist,songs,area){
  if(!artist||!artist.id)return;
  const albScroll=area.querySelector("#srAlbScroll");
  const plScroll=area.querySelector("#srPlScroll");

  // Playlists from artist songs (immediate, no fetch needed)
  const PL_DEFS=[
    {name:\`Éxitos · \${esc(artist.name)}\`,desc:"Sus canciones más escuchadas",icon:"🏆",
     gradient:"linear-gradient(135deg,#a855f7,#6366f1)"},
    {name:\`\${esc(artist.name)} Mix\`,desc:"Una mezcla perfecta",icon:"🎵",
     gradient:"linear-gradient(135deg,#0ea5e9,#2563eb)"},
    {name:\`\${esc(artist.name)} Noche\`,desc:"Para cuando cae la noche",icon:"🌙",
     gradient:"linear-gradient(135deg,#1e1b4b,#6d28d9)"},
    {name:\`\${esc(artist.name)} Chill\`,desc:"La versión relajada",icon:"🌊",
     gradient:"linear-gradient(135deg,#059669,#0891b2)"},
  ];
  if(plScroll&&songs.length){
    const withCovers=songs.filter(s=>s.albumCover);
    plScroll.innerHTML=PL_DEFS.map((pl,i)=>{
      const picks=withCovers.slice(i*2,(i*2)+4);
      let coverHtml;
      if(picks.length>=4){
        coverHtml=\`<div class="sr-pl-cover-grid">\${picks.map(s=>\`<img src="\${esc(s.albumCover)}" loading="lazy">\`).join("")}</div>\`;
      } else if(picks.length>=1){
        coverHtml=\`<img src="\${esc(picks[0].albumCover)}" style="width:100%;height:100%;object-fit:cover" loading="lazy">\`;
      } else {
        coverHtml=\`<div class="sr-pl-cover-icon" style="background:\${pl.gradient}">\${pl.icon}</div>\`;
      }
      return \`<div class="sr-pl-card" data-pl-index="\${i}">
        <div class="sr-pl-cover" style="background:\${pl.gradient}">\${coverHtml}</div>
        <div class="sr-pl-name">\${pl.name}</div>
        <div class="sr-pl-desc">\${pl.desc}</div>
      </div>\`;
    }).join("");
    plScroll.querySelectorAll(".sr-pl-card").forEach(card=>{
      const i=parseInt(card.dataset.plIndex);
      card.addEventListener("click",()=>{
        const shuffled=[...songs].sort(()=>Math.random()-.5);
        const pl={
          name:PL_DEFS[i].name.replace(/&amp;/g,"&"),
          desc:PL_DEFS[i].desc,
          icon:PL_DEFS[i].icon,
          gradient:PL_DEFS[i].gradient,
          color:null,id:"srpl-"+i
        };
        renderPlaylistPage(pl,shuffled,null);
      });
    });
  }

  // Albums from Deezer (async)
  try{
    const res=await fetch(\`/api/artist-albums?id=\${artist.id}\`);
    const data=await res.json();
    const albums=data.albums||[];
    if(!albScroll)return;
    if(!albums.length){albScroll.innerHTML=\`<div style="color:var(--muted);font-size:.8rem">No se encontraron álbumes</div>\`;return;}
    albScroll.innerHTML=albums.map((a,i)=>{
      const year=a.releaseDate?a.releaseDate.slice(0,4):"";
      const typeMap={album:"Álbum",single:"Single",ep:"EP",compilation:"Comp."};
      const badge=typeMap[a.recordType]||a.recordType||"Álbum";
      return \`<div class="sr-alb-card" data-alb-id="\${a.id}" data-alb-index="\${i}">
        <div class="sr-alb-cover">
          \${a.cover?\`<img src="\${esc(a.cover)}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=sr-alb-cover-ph>💿</div>'">\`:\`<div class="sr-alb-cover-ph">💿</div>\`}
          <div class="sr-alb-type">\${badge}</div>
        </div>
        <div class="sr-alb-title">\${esc(a.title)}</div>
        \${year?\`<div class="sr-alb-year">\${year}</div>\`:""}
      </div>\`;
    }).join("");
    albScroll.querySelectorAll(".sr-alb-card").forEach(card=>{
      card.addEventListener("click",()=>openAlbumPage(
        parseInt(card.dataset.albId),
        albums[parseInt(card.dataset.albIndex)]
      ));
    });
  }catch{
    if(albScroll)albScroll.innerHTML=\`<div style="color:var(--muted);font-size:.8rem">Error al cargar álbumes</div>\`;
  }
}

// ─── Novedades Albums ──────────────────────────────────────────────────────────
let albumsCache2=null;

async function loadNovAlbums(container,force){
  if(!container)return;
  try{
    if(!albumsCache2||force){
      const res=await fetch("/api/albums");
      const data=await res.json();
      albumsCache2=data.albums||[];
    }
    renderNovAlbums(container,albumsCache2);
  }catch{
    if(container)container.innerHTML=\`<div style="color:var(--muted);font-size:.8rem;padding:8px">No se pudieron cargar los álbumes</div>\`;
  }
}

function renderNovAlbums(container,albums){
  if(!container||!albums.length)return;
  container.innerHTML=albums.map((a,i)=>{
    const year=a.releaseDate?a.releaseDate.slice(0,4):"";
    const tracks=a.tracksTotal?\`\${a.tracksTotal} canciones\`:"";
    const meta=[year,tracks].filter(Boolean).join(" · ");
    return \`
      <div class="nov-alb-card" data-alb-id="\${a.id}" data-alb-index="\${i}">
        <div class="nov-alb-cover">
          \${a.cover
            ?\`<img src="\${esc(a.cover)}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=nov-alb-cover-ph>💿</div>'">\`
            :\`<div class="nov-alb-cover-ph">💿</div>\`}
          <div class="nov-alb-play">
            <svg width="14" height="14" fill="#000" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </div>
        </div>
        <div class="nov-alb-name">\${esc(a.title)}</div>
        <div class="nov-alb-artist">\${esc(a.artist)}</div>
        \${meta?\`<div class="nov-alb-meta">\${esc(meta)}</div>\`:""}
      </div>
    \`;
  }).join("");
  container.querySelectorAll(".nov-alb-card").forEach(card=>{
    card.addEventListener("click",()=>openAlbumPage(
      parseInt(card.dataset.albId),
      albums[parseInt(card.dataset.albIndex)]
    ));
  });
}

async function openAlbumPage(albumId,albumMeta){
  const content=document.getElementById("mainContent");
  content.innerHTML=\`<div class="ap-loading"><div class="spinner"></div> Cargando álbum...</div>\`;
  try{
    const res=await fetch(\`/api/album-tracks?id=\${albumId}\`);
    const data=await res.json();
    const tracks=data.tracks||[];
    if(!tracks.length){content.innerHTML=\`<div class="ap-loading">No se encontraron canciones</div>\`;return;}
    const pl={
      name:data.title||albumMeta?.title||"Álbum",
      desc:data.artist||albumMeta?.artist||"",
      icon:"💿",
      gradient:albumMeta?\`linear-gradient(135deg,rgba(0,0,0,.6),rgba(0,0,0,.85))\`:"linear-gradient(135deg,#a855f7,#6366f1)",
      color:null,
      id:"album-"+albumId,
    };
    const fakeBack={
      back:()=>{
        if(currentView==="home")loadGenre(currentGenre);
        else setView(currentView);
      }
    };
    renderPlaylistPage(pl,tracks,null);
    // patch back button to go home properly
    setTimeout(()=>{
      const backBtn=content.querySelector("#plBackBtn");
      if(backBtn){
        backBtn.replaceWith(backBtn.cloneNode(true));
        content.querySelector("#plBackBtn").addEventListener("click",()=>loadGenre(currentGenre));
      }
    },50);
    // style hero with album cover
    if(albumMeta?.cover){
      setTimeout(()=>{
        const hero=content.querySelector(".playlist-hero");
        if(hero)hero.style.background="transparent";
      },50);
    }
  }catch{
    content.innerHTML=\`<div class="ap-loading">Error al cargar el álbum</div>\`;
  }
}

// ─── Para Ti & Dice ────────────────────────────────────────────────────────────
const PARA_TI_DEFS=[
  {name:"Tu mix de hoy",   desc:"Basado en lo que escuchas",  icon:"🎯", tag:"🔥 PERSONALIZADO",
   gradient:"linear-gradient(135deg,#a855f7 0%,#6366f1 100%)",
   genres:["pop","reggaeton","latina","hip-hop"]},
  {name:"Descubrimiento",  desc:"Canciones que quizás no conoces", icon:"🌟", tag:"✨ NUEVO",
   gradient:"linear-gradient(135deg,#0ea5e9 0%,#2563eb 100%)",
   genres:["electronica","rock","hip-hop","pop"]},
  {name:"Sesión nocturna", desc:"Para cuando cae la noche",   icon:"🌙", tag:"🌙 NOCHE",
   gradient:"linear-gradient(135deg,#1e1b4b 0%,#4c1d95 50%,#6d28d9 100%)",
   genres:["latina","reggaeton"]},
  {name:"Energía pura",    desc:"Ritmo sin parar",            icon:"⚡", tag:"💥 ENERGY",
   gradient:"linear-gradient(135deg,#f59e0b 0%,#ef4444 100%)",
   genres:["reggaeton","hip-hop","rock"]},
  {name:"Chill session",   desc:"Relájate y disfruta",        icon:"🌊", tag:"😌 CHILL",
   gradient:"linear-gradient(135deg,#059669 0%,#0891b2 100%)",
   genres:["pop","latina"]},
  {name:"Vibra latina",    desc:"El sabor que te mueve",      icon:"💃", tag:"🌴 LATINA",
   gradient:"linear-gradient(135deg,#dc2626 0%,#ea580c 100%)",
   genres:["latina","reggaeton"]},
];

// Seeded shuffle — same seed gives same order (changes every hour)
function seededShuffle(arr,seed){
  const a=[...arr]; let s=seed;
  for(let i=a.length-1;i>0;i--){
    s=(Math.imul(s,1664525)+1013904223)|0;
    const j=Math.abs(s)%(i+1);
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

let _paraTimePlaylists=[];
const _paraGenreCache={};

async function fetchGenreForParaTi(genre){
  if(_paraGenreCache[genre])return _paraGenreCache[genre];
  try{
    const res=await fetch("/api/songs?genre="+genre+"&limit=35");
    if(!res.ok)return[];
    const data=await res.json();
    const songs=(data.songs||[]).map(s=>({...s,genre}));
    _paraGenreCache[genre]=songs;
    return songs;
  }catch{return[];}
}

function buildParaTiPlaylists(allSongs){
  const hourSeed=Math.floor(Date.now()/(1000*60*60));
  _paraTimePlaylists=PARA_TI_DEFS.map((def,i)=>{
    const songs=seededShuffle(allSongs,hourSeed+i*137).slice(0,20);
    return{...def,songs};
  });
  return _paraTimePlaylists;
}

async function loadParaTiSongsAsync(container){
  const allGenres=[...new Set(PARA_TI_DEFS.flatMap(d=>d.genres))];
  await Promise.all(allGenres.map(g=>fetchGenreForParaTi(g)));
  const hourSeed=Math.floor(Date.now()/(1000*60*60));
  _paraTimePlaylists.forEach((pl,i)=>{
    const pool=pl.genres.flatMap(g=>_paraGenreCache[g]||[]);
    const deduped=[...new Map(pool.map(s=>[s.id,s])).values()];
    pl.songs=seededShuffle(deduped,hourSeed+i*137).slice(0,30);
    // Refresh covers
    const el=container.querySelector(\`#ptCover\${i}\`);
    if(!el)return;
    const withCovers=pl.songs.filter(s=>s.albumCover).slice(0,4);
    if(withCovers.length>=4){
      el.className="pt-cover-grid";
      el.innerHTML=withCovers.map(s=>\`<img src="\${esc(s.albumCover)}" loading="lazy" onerror="this.style.background='rgba(0,0,0,.3)'">\`).join("");
    }else if(withCovers.length>=1){
      el.className="pt-cover-icon";el.style.padding="0";
      el.innerHTML=\`<img src="\${esc(withCovers[0].albumCover)}" style="width:100%;height:100%;object-fit:cover" loading="lazy">\`;
    }
  });
}

function loadParaTiCovers(playlists,container){
  playlists.forEach((pl,i)=>{
    const el=container.querySelector(\`#ptCover\${i}\`);
    if(!el)return;
    const withCovers=pl.songs.filter(s=>s.albumCover).slice(0,4);
    if(withCovers.length>=4){
      el.className="pt-cover-grid";
      el.innerHTML=withCovers.map(s=>\`<img src="\${esc(s.albumCover)}" loading="lazy" onerror="this.style.background='rgba(0,0,0,.3)'">\`).join("");
    } else if(withCovers.length>=1){
      el.className="pt-cover-icon";
      el.style.padding="0";
      el.innerHTML=\`<img src="\${esc(withCovers[0].albumCover)}" style="width:100%;height:100%;object-fit:cover" loading="lazy">\`;
    }
  });
}

const GENRE_LABELS={
  pop:"Pop",reggaeton:"Reggaeton",rock:"Rock",latina:"Latina",
  "hip-hop":"Hip-Hop",trap:"Trap",indie:"Indie",electronica:"Electrónica"
};
let _diceLastGenre="";

async function playDiceSong(){
  const fab=document.getElementById("diceFab");
  if(fab){
    if(fab.classList.contains("loading"))return;
    fab.classList.add("loading");
  }
  try{
    const url="/api/dice"+(_diceLastGenre?\`?last=\${encodeURIComponent(_diceLastGenre)}\`:"");
    const res=await fetch(url);
    const data=await res.json();
    const songs=data.songs||[];
    _diceLastGenre=data.genre||"";
    if(!songs.length){showToast("No se encontraron canciones, intenta de nuevo");return;}
    shuffleOn=true;
    const fpsh=document.getElementById("fpShuffle");
    if(fpsh)fpsh.classList.add("on");
    playSong(songs[0],songs);
    const genreLabel=GENRE_LABELS[data.genre]||data.genre||"";
    showToast(\`🎲 \${genreLabel?genreLabel+" · ":""}\${esc(songs[0].title)}\`);
    if(fab){
      fab.classList.remove("loading");
      fab.classList.remove("rolling");
      void fab.offsetWidth;
      fab.classList.add("rolling");
      setTimeout(()=>fab.classList.remove("rolling"),500);
    }
  }catch(e){
    showToast("Error al buscar canciones");
    if(fab)fab.classList.remove("loading");
  }
}

// Dice FAB global init (runs once on page load)
(function initDiceFab(){
  function tryBind(){
    const fab=document.getElementById("diceFab");
    if(!fab){setTimeout(tryBind,200);return;}
    fab.addEventListener("click",()=>playDiceSong());
  }
  tryBind();
})();

// ─── Category & Playlist Pages ─────────────────────────────────────────────────
function getCategoryPlaylists(cat){
  const rows=[
    [
      {suffix:"top",name:\`Top \${cat.label}\`,desc:"Los más escuchados ahora mismo"},
      {suffix:"hits",name:\`Éxitos \${cat.label}\`,desc:"Clásicos que no fallan"},
      {suffix:"new",name:\`Nuevos · \${cat.label}\`,desc:"Recién llegados esta semana"},
      {suffix:"vibes",name:\`\${cat.label} Vibes\`,desc:"El ambiente perfecto"},
    ],
    [
      {suffix:"mix",name:\`\${cat.label} Mix\`,desc:"Una mezcla para todos"},
      {suffix:"night",name:\`\${cat.label} Noche\`,desc:"Para las noches especiales"},
      {suffix:"chill",name:\`\${cat.label} Chill\`,desc:"Relájate con esto"},
      {suffix:"fire",name:\`\${cat.label} 🔥\`,desc:"Las que están en boca de todos"},
    ],
  ];
  return rows.map(section=>section.map(p=>({
    ...p,
    id:\`\${cat.id}-\${p.suffix}\`,
    genre:cat.genre,
    color:cat.color,
    icon:cat.icon,
    catId:cat.id,
    catLabel:cat.label,
  })));
}

function openCategoryPage(cat){
  const content=document.getElementById("mainContent");
  content.innerHTML=\`<div class="ap-loading"><div class="spinner"></div> Cargando...</div>\`;
  renderCategoryPage(cat);
}

function renderCategoryPage(cat){
  const content=document.getElementById("mainContent");
  const sections=getCategoryPlaylists(cat);
  const sectionTitles=["Playlists populares","También te puede gustar"];
  content.innerHTML=\`
    <div class="cat-page">
      <div class="cat-hero">
        <div class="cat-hero-bg" style="background:\${cat.color}"></div>
        <div class="cat-hero-gradient"></div>
        <button class="cat-hero-back" id="catBackBtn">
          <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span class="cat-hero-icon">\${cat.icon}</span>
        <div class="cat-hero-title">\${esc(cat.label)}</div>
      </div>
      \${sections.map((pls,si)=>\`
        <div class="cat-section"><div class="cat-section-title">\${sectionTitles[si]}</div></div>
        <div class="playlist-scroll">
          \${pls.map((pl,pi)=>\`
            <div class="pl-card" data-si="\${si}" data-pi="\${pi}">
              <div class="pl-card-cover" style="background:\${cat.color}">
                <div class="pl-card-cover-single">\${cat.icon}</div>
              </div>
              <div class="pl-card-name">\${esc(pl.name)}</div>
              <div class="pl-card-desc">\${esc(pl.desc)}</div>
            </div>
          \`).join("")}
        </div>
      \`).join("")}
      <div style="padding-bottom:36px"></div>
    </div>
  \`;
  content.querySelector("#catBackBtn").addEventListener("click",()=>setView("search"));
  content.querySelectorAll(".pl-card").forEach(card=>{
    const si=parseInt(card.dataset.si),pi=parseInt(card.dataset.pi);
    card.addEventListener("click",()=>openPlaylistPage(sections[si][pi],cat));
  });
  loadCategoryCovers(cat,sections,content);
}

async function loadCategoryCovers(cat,sections,container){
  try{
    const res=await fetch(\`/api/songs?genre=\${encodeURIComponent(cat.genre)}&limit=20\`);
    const data=await res.json();
    const songs=data.songs||[];
    if(!songs.length)return;
    sections.forEach((pls,si)=>{
      pls.forEach((pl,pi)=>{
        const card=container.querySelector(\`[data-si="\${si}"][data-pi="\${pi}"]\`);
        if(!card)return;
        const coverEl=card.querySelector(".pl-card-cover");
        if(!coverEl)return;
        const offset=(si*4+pi*4)%songs.length;
        const picks=Array.from({length:4},(_,k)=>songs[(offset+k)%songs.length]);
        const withCovers=picks.filter(s=>s.albumCover);
        if(withCovers.length>=4){
          coverEl.innerHTML=\`<div class="pl-card-cover-grid">
            \${withCovers.slice(0,4).map(s=>\`<img src="\${esc(s.albumCover)}" loading="lazy" onerror="this.style.background='rgba(168,85,247,.3)'">\`).join("")}
          </div>\`;
        } else if(withCovers.length>=1){
          coverEl.innerHTML=\`<img src="\${esc(withCovers[0].albumCover)}" style="width:100%;height:100%;object-fit:cover" loading="lazy">\`;
        }
      });
    });
  }catch{}
}

function seedShuffle(arr,seed){
  const a=[...arr];let s=seed||1;
  for(let i=a.length-1;i>0;i--){
    s=(s*1664525+1013904223)&0xffffffff;
    const j=Math.abs(s)%(i+1);
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

async function openPlaylistPage(playlist,cat){
  const content=document.getElementById("mainContent");
  content.innerHTML=\`<div class="ap-loading"><div class="spinner"></div> Cargando playlist...</div>\`;
  try{
    const res=await fetch(\`/api/songs?genre=\${encodeURIComponent(playlist.genre)}&limit=25\`);
    const data=await res.json();
    const seed=playlist.id.split("").reduce((a,c)=>a+c.charCodeAt(0),0);
    const songs=seedShuffle(data.songs||[],seed);
    renderPlaylistPage(playlist,songs,cat);
  }catch(e){
    document.getElementById("mainContent").innerHTML=\`<div class="ap-loading">Error al cargar la playlist</div>\`;
  }
}

function renderPlaylistPage(playlist,songs,cat){
  const content=document.getElementById("mainContent");
  const totalSecs=songs.reduce((t,s)=>t+(s.duration||210),0);
  const totalMins=Math.round(totalSecs/60);
  const totalStr=totalMins>=60?\`\${Math.floor(totalMins/60)} h \${totalMins%60} min\`:\`\${totalMins} min\`;
  const withCovers=songs.filter(s=>s.albumCover).slice(0,4);
  let coverHtml;
  if(withCovers.length>=4){
    coverHtml=\`<div class="pl-hero-cover-grid">
      \${withCovers.map(s=>\`<img src="\${esc(s.albumCover)}" loading="lazy" onerror="this.style.background='rgba(168,85,247,.3)'">\`).join("")}
    </div>\`;
  } else if(withCovers.length>=1){
    coverHtml=\`<img src="\${esc(withCovers[0].albumCover)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">\`;
  } else {
    const bg=cat?cat.color:"linear-gradient(135deg,#a855f7,#6366f1)";
    coverHtml=\`<div class="pl-hero-cover-single" style="background:\${bg}">\${playlist.icon||"🎵"}</div>\`;
  }
  const trackRows=songs.map((s,i)=>{
    const cover=s.albumCover
      ?\`<img class="pl-track-cover" src="\${esc(s.albumCover)}" loading="lazy" onerror="this.outerHTML='<div class=pl-track-cover-ph>🎵</div>'">\`
      :\`<div class="pl-track-cover-ph">🎵</div>\`;
    const dur=s.duration?Math.floor(s.duration/60)+":"+(s.duration%60<10?"0":"")+s.duration%60:"";
    const playing=currentSong&&currentSong.id===s.id;
    return \`<div class="pl-track-row" data-index="\${i}">
      <div class="pl-track-num\${playing?" playing":""}"><span>\${playing?"▶":i+1}</span></div>
      \${cover}
      <div class="pl-track-info">
        <div class="pl-track-title\${playing?" playing":""}">\${esc(s.title)}</div>
        <div class="pl-track-meta">\${esc(s.artistName)}\${dur?" · "+dur:""}</div>
      </div>
      <button class="pl-track-dots">⋮</button>
    </div>\`;
  }).join("");
  content.innerHTML=\`
    <div class="playlist-page">
      <div class="playlist-hero" \${cat?\`style="background:\${cat.color}"\`:""}>
        \${coverHtml}
        <div class="pl-hero-gradient"></div>
        <button class="pl-hero-back" id="plBackBtn">
          <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div class="pl-hero-info">
          <div class="pl-hero-name">\${esc(playlist.name)}</div>
          <div class="pl-hero-desc">\${esc(playlist.desc||"")}</div>
        </div>
      </div>
      <div class="pl-actions">
        <button class="pl-act-btn" title="Agregar">
          <svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
        </button>
        <button class="pl-act-btn" title="Más">
          <svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
        </button>
        <span style="font-size:.76rem;color:var(--muted);flex-shrink:0">\${songs.length} canciones · \${totalStr}</span>
        <div class="pl-spacer"></div>
        <button class="pl-shuffle-btn" id="plShuffleBtn">
          <svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>
        </button>
        <button class="pl-play-btn" id="plPlayBtn">
          <svg width="24" height="24" fill="#000" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
      </div>
      \${trackRows}
      <div style="padding-bottom:36px"></div>
    </div>
  \`;
  content.querySelector("#plBackBtn").addEventListener("click",()=>{ if(cat)renderCategoryPage(cat); else setView("search"); });
  content.querySelector("#plPlayBtn").addEventListener("click",()=>{ if(songs.length)playSong(songs[0],songs); });
  content.querySelector("#plShuffleBtn").addEventListener("click",()=>{
    if(!songs.length)return;
    const sh=[...songs].sort(()=>Math.random()-.5);
    playSong(sh[0],sh);
  });
  content.querySelectorAll(".pl-track-row").forEach(row=>{
    const i=parseInt(row.dataset.index);
    row.addEventListener("click",()=>playSong(songs[i],songs));
    row.querySelector(".pl-track-dots").addEventListener("click",e=>{e.stopPropagation();openCtxMenu(e,songs[i]);});
  });
}

// ─── Artist Profile ────────────────────────────────────────────────────────────
let artistProfileBack=null;

async function openArtistProfile(artist){
  artistProfileBack=currentView;
  const content=document.getElementById("mainContent");
  content.innerHTML=\`<div class="ap-loading"><div class="spinner"></div> Cargando artista…</div>\`;
  try{
    const params=new URLSearchParams({name:artist.name||\"\",deezerId:artist.id||\"\",});
    const res=await fetch("/api/artist-profile?"+params);
    const data=await res.json();
    renderArtistProfile(data.artist||artist, data.tracks||[]);
  }catch(e){
    content.innerHTML=\`<div class="ap-loading">Error al cargar el artista</div>\`;
  }
}

function renderArtistProfile(artist, tracks){
  const content=document.getElementById("mainContent");
  const heroBg=artist.image
    ?\`<img class="artist-hero-bg" src="\${esc(artist.image)}" loading="eager">\`
    :\`<div class="artist-hero-bg-ph"></div>\`;
  const fansStr=artist.fans?fmtFans(artist.fans):\"\";
  const trackRows=tracks.map((t,i)=>{
    const cover=t.albumCover
      ?\`<img class="ap-track-cover" src="\${esc(t.albumCover)}" loading="lazy" onerror="this.outerHTML='<div class=ap-track-cover-ph>🎵</div>'">\`
      :\`<div class="ap-track-cover-ph">🎵</div>\`;
    const isPlaying=currentSong&&currentSong.id===t.id;
    return \`<div class="ap-track-row" data-index="\${i}">
      <div class="ap-track-num">\${i+1}</div>
      \${cover}
      <div class="ap-track-info">
        <div class="ap-track-title\${isPlaying?" playing":""}">\${esc(t.title)}</div>
        <div class="ap-track-sub">Canción\${t.albumTitle?" · "+esc(t.albumTitle):""}</div>
      </div>
      <button class="ap-track-dots" title="Más opciones">⋮</button>
    </div>\`;
  }).join("");
  content.innerHTML=\`
    <div class="artist-profile">
      <div class="artist-hero">
        \${heroBg}
        <div class="artist-hero-gradient"></div>
        <button class="artist-hero-back" id="apBackBtn">
          <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div class="artist-hero-info">
          <div class="artist-hero-name">\${esc(artist.name)}</div>
          \${fansStr?\`<div class="artist-hero-fans">\${esc(fansStr)}</div>\`:""}
        </div>
      </div>
      <div class="artist-profile-actions">
        <button class="ap-btn-follow">Seguir</button>
        <button class="ap-btn-more">⋯</button>
        <div class="ap-spacer"></div>
        <button class="ap-btn-shuffle" id="apShuffleBtn" title="Aleatorio">
          <svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>
        </button>
        <button class="ap-btn-play" id="apPlayBtn">
          <svg width="22" height="22" fill="#000" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
      </div>
      <div class="artist-profile-tabs">
        <div class="ap-tab active">Música</div>
      </div>
      <div class="artist-popular-label">Populares</div>
      \${trackRows}
      <div style="padding-bottom:36px"></div>
    </div>
  \`;
  content.querySelector("#apBackBtn").addEventListener("click",()=>setView(artistProfileBack||"search"));
  content.querySelector("#apPlayBtn").addEventListener("click",()=>{if(tracks.length)playSong(tracks[0],tracks);});
  content.querySelector("#apShuffleBtn").addEventListener("click",()=>{
    if(!tracks.length)return;
    const sh=[...tracks].sort(()=>Math.random()-.5);
    playSong(sh[0],sh);
  });
  content.querySelectorAll(".ap-track-row").forEach(row=>{
    const i=parseInt(row.dataset.index);
    row.addEventListener("click",()=>playSong(tracks[i],tracks));
    row.querySelector(".ap-track-dots").addEventListener("click",e=>{e.stopPropagation();openCtxMenu(e,tracks[i]);});
  });
}

// ─── Navigation ────────────────────────────────────────────────────────────────
function setView(view){
  currentView=view;
  document.querySelectorAll(".sidebar-item[data-view]").forEach(b=>b.classList.toggle("active",b.dataset.view===view));
  document.querySelectorAll(".nav-item[data-view]").forEach(b=>b.classList.toggle("active",b.dataset.view===view));
  if(view==="home"){ loadGenre(currentGenre); }
  else if(view==="search"){ renderSearch(); }
  else if(view==="library"){ renderLibrary(); }
  else if(view==="trending"){ renderTrending(); }
}

document.querySelectorAll(".sidebar-item[data-view], .nav-item[data-view]").forEach(btn=>{
  btn.addEventListener("click",()=>setView(btn.dataset.view));
});
document.querySelectorAll(".sidebar-item[data-genre], .nav-item[data-genre]").forEach(btn=>{
  btn.addEventListener("click",()=>{setView("home");setTimeout(()=>loadGenre(btn.dataset.genre),50);});
});

document.getElementById("miniProgress").addEventListener("click",e=>{
  if(!duration||!ytPlayer||!ytReady)return;
  const r=e.currentTarget.getBoundingClientRect();
  const pct=(e.clientX-r.left)/r.width;
  try{ytPlayer.seekTo(pct*duration,true);}catch{}
});

// ─── Boot ──────────────────────────────────────────────────────────────────────
// Set initial Audio/Video button state from saved preference
document.getElementById("fpModeAudio").classList.toggle("active", playerMode==="audio");
document.getElementById("fpModeVideo").classList.toggle("active", playerMode==="video");
updateProfileStats();
setView("home");
</script>
</body>
</html>`;

app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.send(HTML);
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor corriendo en http://0.0.0.0:${PORT}`);
});
