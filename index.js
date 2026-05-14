const http = require("http");

const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Música Pro</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Segoe UI', sans-serif;
      background: #0a0a0f;
      color: #fff;
      overflow-x: hidden;
    }

    /* NAV */
    nav {
      position: fixed;
      top: 0; left: 0; right: 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px 60px;
      background: rgba(10,10,15,0.85);
      backdrop-filter: blur(12px);
      z-index: 100;
      border-bottom: 1px solid rgba(255,255,255,0.07);
    }

    .logo {
      font-size: 1.5rem;
      font-weight: 800;
      letter-spacing: 2px;
      background: linear-gradient(90deg, #a855f7, #ec4899);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    nav ul {
      list-style: none;
      display: flex;
      gap: 40px;
    }

    nav ul a {
      color: rgba(255,255,255,0.7);
      text-decoration: none;
      font-size: 0.9rem;
      letter-spacing: 1px;
      transition: color 0.3s;
    }

    nav ul a:hover { color: #fff; }

    /* HERO */
    .hero {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      text-align: center;
      padding: 120px 20px 60px;
      background: radial-gradient(ellipse at 50% 40%, rgba(168,85,247,0.2) 0%, transparent 70%);
    }

    .hero-tag {
      font-size: 0.75rem;
      letter-spacing: 4px;
      text-transform: uppercase;
      color: #a855f7;
      margin-bottom: 20px;
    }

    .hero h1 {
      font-size: clamp(2.5rem, 7vw, 5.5rem);
      font-weight: 900;
      line-height: 1.1;
      max-width: 800px;
      margin-bottom: 24px;
    }

    .hero h1 span {
      background: linear-gradient(90deg, #a855f7, #ec4899);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .hero p {
      font-size: 1.1rem;
      color: rgba(255,255,255,0.55);
      max-width: 520px;
      line-height: 1.8;
      margin-bottom: 40px;
    }

    .btn-group { display: flex; gap: 16px; flex-wrap: wrap; justify-content: center; }

    .btn {
      padding: 14px 36px;
      border-radius: 50px;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: transform 0.2s, box-shadow 0.2s;
      text-decoration: none;
    }

    .btn:hover { transform: translateY(-2px); }

    .btn-primary {
      background: linear-gradient(135deg, #a855f7, #ec4899);
      color: #fff;
      box-shadow: 0 4px 30px rgba(168,85,247,0.5);
    }

    .btn-secondary {
      background: transparent;
      color: #fff;
      border: 1px solid rgba(255,255,255,0.25);
    }

    .btn-secondary:hover { border-color: #a855f7; }

    /* NOW PLAYING */
    .player {
      margin: 60px auto 0;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 20px;
      padding: 24px 32px;
      display: flex;
      align-items: center;
      gap: 24px;
      max-width: 520px;
      backdrop-filter: blur(10px);
    }

    .album-art {
      width: 58px; height: 58px;
      border-radius: 12px;
      background: linear-gradient(135deg, #a855f7, #ec4899);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.6rem;
      flex-shrink: 0;
    }

    .track-info { flex: 1; }
    .track-name { font-weight: 700; font-size: 1rem; }
    .track-artist { color: rgba(255,255,255,0.5); font-size: 0.85rem; margin-top: 2px; }

    .progress-bar {
      width: 100%;
      height: 4px;
      background: rgba(255,255,255,0.15);
      border-radius: 4px;
      margin-top: 10px;
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      width: 40%;
      background: linear-gradient(90deg, #a855f7, #ec4899);
      border-radius: 4px;
      animation: progress 8s linear infinite;
    }

    @keyframes progress {
      from { width: 0%; }
      to { width: 100%; }
    }

    .play-btn {
      width: 44px; height: 44px;
      border-radius: 50%;
      background: linear-gradient(135deg, #a855f7, #ec4899);
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1rem;
      flex-shrink: 0;
      box-shadow: 0 4px 20px rgba(168,85,247,0.4);
      transition: transform 0.2s;
    }

    .play-btn:hover { transform: scale(1.1); }

    /* TRACKS */
    .section {
      padding: 100px 60px;
      max-width: 1200px;
      margin: 0 auto;
    }

    .section-title {
      font-size: 0.75rem;
      letter-spacing: 4px;
      text-transform: uppercase;
      color: #a855f7;
      margin-bottom: 12px;
    }

    .section h2 {
      font-size: clamp(1.8rem, 4vw, 3rem);
      font-weight: 800;
      margin-bottom: 50px;
    }

    .tracks-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 24px;
    }

    .track-card {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 16px;
      padding: 24px;
      transition: border-color 0.3s, transform 0.3s;
      cursor: pointer;
    }

    .track-card:hover {
      border-color: rgba(168,85,247,0.5);
      transform: translateY(-4px);
    }

    .card-cover {
      width: 100%;
      aspect-ratio: 1;
      border-radius: 10px;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 3rem;
    }

    .card-title { font-weight: 700; font-size: 1rem; margin-bottom: 4px; }
    .card-sub { color: rgba(255,255,255,0.45); font-size: 0.85rem; }
    .card-duration { color: rgba(255,255,255,0.3); font-size: 0.8rem; margin-top: 10px; }

    /* STATS */
    .stats {
      padding: 80px 60px;
      background: rgba(255,255,255,0.02);
      border-top: 1px solid rgba(255,255,255,0.05);
      border-bottom: 1px solid rgba(255,255,255,0.05);
    }

    .stats-inner {
      max-width: 1200px;
      margin: 0 auto;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 40px;
      text-align: center;
    }

    .stat-num {
      font-size: 2.8rem;
      font-weight: 900;
      background: linear-gradient(90deg, #a855f7, #ec4899);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .stat-label { color: rgba(255,255,255,0.45); font-size: 0.9rem; margin-top: 6px; }

    /* FOOTER */
    footer {
      text-align: center;
      padding: 40px 20px;
      color: rgba(255,255,255,0.25);
      font-size: 0.85rem;
    }
  </style>
</head>
<body>

  <nav>
    <div class="logo">♪ MÚSICA PRO</div>
    <ul>
      <li><a href="#">Inicio</a></li>
      <li><a href="#">Álbumes</a></li>
      <li><a href="#">Artistas</a></li>
      <li><a href="#">Conciertos</a></li>
      <li><a href="#">Contacto</a></li>
    </ul>
  </nav>

  <section class="hero">
    <p class="hero-tag">🎧 Experiencia Musical</p>
    <h1>Siente la <span>Música</span> como nunca antes</h1>
    <p>Descubre millones de canciones, álbumes y artistas. Una experiencia de audio de calidad profesional en tus manos.</p>
    <div class="btn-group">
      <a href="#" class="btn btn-primary">Escuchar Ahora</a>
      <a href="#" class="btn btn-secondary">Ver Catálogo</a>
    </div>

    <div class="player">
      <div class="album-art">🎵</div>
      <div class="track-info">
        <div class="track-name">Noche de Verano</div>
        <div class="track-artist">Luna & Los Beats</div>
        <div class="progress-bar">
          <div class="progress-fill"></div>
        </div>
      </div>
      <button class="play-btn">▶</button>
    </div>
  </section>

  <section class="section">
    <p class="section-title">🔥 Tendencias</p>
    <h2>Lo más escuchado</h2>
    <div class="tracks-grid">
      <div class="track-card">
        <div class="card-cover" style="background: linear-gradient(135deg,#a855f7,#6366f1);">🎸</div>
        <div class="card-title">Ecos del Alma</div>
        <div class="card-sub">Valentina Cruz</div>
        <div class="card-duration">3:42</div>
      </div>
      <div class="track-card">
        <div class="card-cover" style="background: linear-gradient(135deg,#ec4899,#f97316);">🎹</div>
        <div class="card-title">Ciudad de Luces</div>
        <div class="card-sub">El Sonido Nuevo</div>
        <div class="card-duration">4:15</div>
      </div>
      <div class="track-card">
        <div class="card-cover" style="background: linear-gradient(135deg,#06b6d4,#3b82f6);">🎷</div>
        <div class="card-title">Jazz de Medianoche</div>
        <div class="card-sub">Trio Stellare</div>
        <div class="card-duration">5:08</div>
      </div>
      <div class="track-card">
        <div class="card-cover" style="background: linear-gradient(135deg,#84cc16,#10b981);">🎻</div>
        <div class="card-title">Sinfonía del Viento</div>
        <div class="card-sub">Orquesta Moderna</div>
        <div class="card-duration">6:30</div>
      </div>
    </div>
  </section>

  <div class="stats">
    <div class="stats-inner">
      <div>
        <div class="stat-num">50M+</div>
        <div class="stat-label">Canciones disponibles</div>
      </div>
      <div>
        <div class="stat-num">120K+</div>
        <div class="stat-label">Artistas</div>
      </div>
      <div>
        <div class="stat-num">8M+</div>
        <div class="stat-label">Usuarios activos</div>
      </div>
      <div>
        <div class="stat-num">99%</div>
        <div class="stat-label">Calidad de audio</div>
      </div>
    </div>
  </div>

  <footer>
    <p>© 2026 Música Pro · Todos los derechos reservados</p>
  </footer>

</body>
</html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
});

const PORT = 5000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor corriendo en http://0.0.0.0:${PORT}`);
});
