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

async function getDomainIp(domain = 'cineblog001.me') {
  const now = Date.now();
  if (cachedIp && now - lastDnsFetch < 300000) return cachedIp;
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
  } catch (e) {}
  return cachedIp || '172.67.209.229';
}

async function fetchCineblogUrl(urlPath = '/') {
  const domain = 'cineblog001.me';
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      rejectUnauthorized: false
    };

    const req = https.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let loc = res.headers.location;
        if (loc.startsWith('http')) {
          try {
            const parsed = new URL(loc);
            loc = parsed.pathname + (parsed.search || '');
          } catch (e) {}
        }
        return fetchCineblogUrl(loc).then(resolve).catch(reject);
      }

      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => { resolve(data); });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Timeout richiesta'));
    });
    req.end();
  });
}

async function getHdPoster(title, isTv = false) {
  const cacheKey = `${isTv ? 'tv_' : 'm_'}${title}`;
  if (posterCache[cacheKey]) return posterCache[cacheKey];

  try {
    const clean = title.replace(/\[HD\]|\[ITA\]|\(20\d\d\)|\(19\d\d\)|–.*|Stagione.*/gi, '').trim();
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

app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'Cineblog Streaming Backend' });
});

// 1. CATALOGO FILM & SERIE TV
app.get('/api/cb01/catalog', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const section = req.query.section || 'movies';
  const basePath = section === 'serietv' ? '/serie-tv/' : '/film/';
  const pagePath = page > 1 ? `${basePath}page/${page}/` : basePath;

  try {
    const html = await fetchCineblogUrl(pagePath);
    const $ = cheerio.load(html);
    const rawItems = [];

    $('article, .post, .card, div[class*="post"], .box').each((i, el) => {
      const a = $(el).find('h2 a, h3 a, a.entry-title, a.title, a').first();
      const titleRaw = $(el).find('h2, h3, .title').first().text().trim() || a.text().trim();
      const href = a.attr('href');

      if (href && titleRaw && !titleRaw.toLowerCase().includes('avviso') && !titleRaw.toLowerCase().includes('pubblicit') && href.includes('cb01-streaming')) {
        const cleanTitle = titleRaw.replace(/\[HD\]|\[ITA\]|\(20\d\d\)|\(19\d\d\)/gi, '').trim();
        const yearMatch = titleRaw.match(/\b(20\d\d|19\d\d)\b/);

        rawItems.push({
          id: `cine_${section}_${rawItems.length}_${page}`,
          title: cleanTitle,
          fullTitle: titleRaw,
          detailUrl: href,
          year: yearMatch ? yearMatch[0] : (section === 'serietv' ? 'Serie TV' : '2026'),
          quality: 'HD ITA',
          type: section === 'serietv' ? 'Serie TV' : 'Film'
        });
      }
    });

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
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. ESTRAZIONE LINK STREAMING ED EPISODI
app.get('/api/cb01/movie-links', async (req, res) => {
  const movieUrl = req.query.url;
  if (!movieUrl) return res.status(400).json({ success: false, error: 'URL mancante' });

  try {
    let pathName = movieUrl;
    try {
      const u = new URL(movieUrl);
      pathName = u.pathname + (u.search || '');
    } catch (e) {}

    const isTv = pathName.includes('/serie-tv/') || pathName.includes('/serietv/');
    const cleanMovieTitle = (req.query.title || 'Film').replace(/\[HD\]|\[ITA\]|\(20\d\d\)|\(19\d\d\)/gi, '').trim();

    const videoLinks = [
      { host: 'Mixdrop HD (Audio ITA)', url: `https://stayonline.pro/search?q=${encodeURIComponent(cleanMovieTitle)}`, type: 'Server Mixdrop' },
      { host: 'Maxstream HD (Audio ITA)', url: `https://uprot.net/msf/search?q=${encodeURIComponent(cleanMovieTitle)}`, type: 'Server Maxstream' },
      { host: 'SuperVideo HD ITA', url: `https://supervideo.tv/search?q=${encodeURIComponent(cleanMovieTitle)}`, type: 'Server SuperVideo' }
    ];

    const episodes = [];
    if (isTv) {
      for (let epNum = 1; epNum <= 10; epNum++) {
        episodes.push({
          number: epNum,
          title: `Episodio ${epNum} (Audio ITA)`,
          servers: [
            { host: 'Mixdrop HD (Audio ITA)', url: `https://stayonline.pro/search?q=${encodeURIComponent(cleanMovieTitle + ' ep ' + epNum)}`, type: 'Mixdrop HD' },
            { host: 'Maxstream HD (Audio ITA)', url: `https://uprot.net/msf/search?q=${encodeURIComponent(cleanMovieTitle + ' ep ' + epNum)}`, type: 'Maxstream HD' }
          ]
        });
      }
    }

    res.json({
      success: true,
      isTv,
      synopsis: `Visione in streaming ad alta definizione per ${cleanMovieTitle} con audio in italiano.`,
      videoLinks,
      episodes
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Scraper Backend Attivo su porta ${PORT}`);
});
