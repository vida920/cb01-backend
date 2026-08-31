const express = require('express');
const cors = require('cors');
const https = require('https');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const TMDB_API_KEY = '844dba0bfd8f3a4f3799f6130ef9e335';
const posterCache = {};

let cachedIp = null;
let lastDnsFetch = 0;

async function getDomainIp(domain = 'cb01uno.lat') {
  const now = Date.now();
  if (cachedIp && now - lastDnsFetch < 300000) {
    return cachedIp;
  }
  try {
    const doh = await axios.get(`https://cloudflare-dns.com/dns-query?name=${domain}&type=A`, {
      headers: { 'accept': 'application/dns-json' },
      timeout: 5000
    });
    if (doh.data && doh.data.Answer && doh.data.Answer.length > 0) {
      cachedIp = doh.data.Answer[0].data;
      lastDnsFetch = now;
      return cachedIp;
    }
  } catch (e) {
    console.warn('Errore DoH, fallback IP:', e.message);
  }
  return cachedIp || '104.21.22.13';
}

async function fetchCb01Url(urlPath = '/') {
  const domain = 'cb01uno.lat';
  const ip = await getDomainIp(domain);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: ip,
      port: 443,
      path: urlPath,
      method: 'GET',
      servername: domain,
      headers: {
        'Host': domain,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      rejectUnauthorized: false
    };

    const req = https.request(options, (res) => {
      // Segui redirect se necessario
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let loc = res.headers.location;
        if (loc.startsWith('http')) {
          try {
            const parsed = new URL(loc);
            loc = parsed.pathname + (parsed.search || '');
          } catch (e) {}
        }
        return fetchCb01Url(loc).then(resolve).catch(reject);
      }

      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => { resolve(data); });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Timeout richiesta CB01'));
    });
    req.end();
  });
}

// Risolutore locandina HD
async function getHdPoster(title, isTv = false) {
  const cacheKey = `${isTv ? 'tv_' : 'm_'}${title}`;
  if (posterCache[cacheKey]) return posterCache[cacheKey];

  try {
    const clean = title.replace(/\[HD\]|\(20\d\d\)|\(19\d\d\)|–.*|Stagione.*/gi, '').trim();
    const type = isTv ? 'tv' : 'movie';
    const res = await axios.get(`https://api.themoviedb.org/3/search/${type}?api_key=${TMDB_API_KEY}&language=it-IT&query=${encodeURIComponent(clean)}`, { timeout: 4000 });
    const match = res.data?.results?.[0];
    if (match && match.poster_path) {
      const posterUrl = `https://image.tmdb.org/t/p/w500${match.poster_path}`;
      posterCache[cacheKey] = posterUrl;
      return posterUrl;
    }
  } catch (e) {}

  return 'https://via.placeholder.com/300x450/1e2130/ffffff?text=' + encodeURIComponent(title);
}

// Endpoint base per controllo stato
app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'CB01 Scraper Backend' });
});

// 1. Catalogo Diviso tra FILM e SERIE TV da cb01
app.get('/api/cb01/catalog', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const section = req.query.section || 'movies'; // 'movies' o 'serietv'
  const basePath = section === 'serietv' ? '/serietv/' : '/';
  const pagePath = page > 1 ? `${basePath}page/${page}/` : basePath;

  try {
    const html = await fetchCb01Url(pagePath);
    const $ = cheerio.load(html);
    const rawItems = [];

    $('article, .post, .card, div[class*="post"]').each((i, el) => {
      const a = $(el).find('h2 a, h3 a, a.entry-title').first();
      const titleRaw = $(el).find('h2, h3').text().trim();
      const href = a.attr('href') || $(el).find('a').first().attr('href');

      if (href && titleRaw && !titleRaw.includes('avviso')) {
        const title = titleRaw.replace(/\[HD\]|\(20\d\d\)|\(19\d\d\)/gi, '').trim();
        const yearMatch = titleRaw.match(/\b(20\d\d|19\d\d)\b/);

        rawItems.push({
          id: `cb01_${section}_${rawItems.length}_${page}`,
          title: title,
          fullTitle: titleRaw,
          detailUrl: href,
          year: yearMatch ? yearMatch[0] : (section === 'serietv' ? 'Serie TV' : '2026'),
          quality: 'HD ITA',
          type: section === 'serietv' ? 'Serie TV' : 'Film'
        });
      }
    });

    // Locandine HD per ogni elemento
    const itemsWithPosters = await Promise.all(
      rawItems.map(async (item) => {
        const hdPoster = await getHdPoster(item.title, section === 'serietv');
        return {
          ...item,
          poster: hdPoster
        };
      })
    );

    res.json({ success: true, section, page: Number(page), items: itemsWithPosters });
  } catch (err) {
    console.error('Errore /api/cb01/catalog:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Estrazione Link Video & Episodi
app.get('/api/cb01/movie-links', async (req, res) => {
  const movieUrl = req.query.url;
  if (!movieUrl) return res.status(400).json({ success: false, error: 'URL mancante' });

  try {
    let pathName = movieUrl;
    try {
      const u = new URL(movieUrl);
      pathName = u.pathname + (u.search || '');
    } catch (e) {}

    const isTv = pathName.includes('/serietv/');
    const html = await fetchCb01Url(pathName);
    const $ = cheerio.load(html);

    const synopsis = $('.entry-content p, .story p').first().text().trim() || 'Trama e dettagli estratti da CB01';
    const videoLinks = [];
    const episodes = [];

    $('a').each((_, link) => {
      const href = $(link).attr('href');
      const text = $(link).text().trim();

      if (href && (href.includes('uprot.net') || href.includes('stayonline.pro') || href.includes('mixdrop') || href.includes('supervideo') || href.includes('streamtape') || href.includes('swzz.xyz') || href.includes('deltabit') || href.includes('dropload') || href.includes('voe') || href.includes('maxstream'))) {
        let hostName = text || 'Streaming Server';
        if (href.includes('stayonline.pro') || href.includes('mixdrop')) hostName = 'Mixdrop HD (Audio ITA)';
        else if (href.includes('uprot.net') || href.includes('maxstream')) hostName = 'Maxstream HD (Audio ITA)';
        else if (href.includes('supervideo')) hostName = 'SuperVideo HD ITA';

        videoLinks.push({ host: hostName, url: href, type: 'Video Server' });
      }
    });

    if (isTv && videoLinks.length > 0) {
      for (let i = 0; i < videoLinks.length; i += 2) {
        const epNum = Math.floor(i / 2) + 1;
        const epServers = [videoLinks[i]];
        if (videoLinks[i + 1]) epServers.push(videoLinks[i + 1]);

        episodes.push({
          number: epNum,
          title: `Episodio ${epNum} (Audio ITA)`,
          servers: epServers
        });
      }
    }

    res.json({
      success: true,
      isTv,
      synopsis,
      videoLinks,
      episodes
    });
  } catch (err) {
    console.error('Errore /api/cb01/movie-links:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Scraper Backend Attivo su porta ${PORT}`);
});
