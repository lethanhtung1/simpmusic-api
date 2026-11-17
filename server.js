import express from 'express';
import cors from 'cors';
import { Readable } from 'node:stream';
import { Innertube, UniversalCache } from 'youtubei.js';

const app = express();
app.use(cors({ exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'] }));

let ytPromise;
function getYT() {
  if (!ytPromise) {
    ytPromise = Innertube.create({ cache: new UniversalCache(false) }).catch((e) => {
      ytPromise = null; // cho phép thử lại lần sau
      throw e;
    });
  }
  return ytPromise;
}
getYT().then(() => console.log('✅ InnerTube đã sẵn sàng!')).catch((e) => console.error('Lỗi khởi tạo InnerTube:', e));

app.get('/health', (_req, res) => res.send('ok'));

// 1. Tìm kiếm
app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.json([]);
    const yt = await getYT();
    const search = await yt.search(q, { type: 'video' });
    const songs = search.results
      .filter((item) => item.type === 'Video')
      .map((item) => ({
        id: item.id,
        title: item.title?.text || String(item.title || ''),
        artist: item.author?.name || 'Unknown',
        thumbnail: item.thumbnails?.[0]?.url || '',
      }));
    res.json(songs);
  } catch (err) {
    console.error('Lỗi tìm kiếm:', err);
    res.status(500).json({ error: err.message });
  }
});

// 2. Lấy link audio (thử nhiều client), có cache
const CLIENTS = ['IOS', 'ANDROID', 'TV', 'WEB_EMBEDDED', 'WEB'];
const urlCache = new Map(); // id -> { url, mime, exp }

async function resolveAudio(id) {
  const hit = urlCache.get(id);
  if (hit && hit.exp > Date.now()) return hit;

  const yt = await getYT();
  const errs = [];
  for (const client of CLIENTS) {
    try {
      const info = await yt.getBasicInfo(id, { client });
      // ưu tiên m4a (mp4) để chạy được cả Safari/iPhone
      let format;
      try {
        format = info.chooseFormat({ type: 'audio', quality: 'best', format: 'mp4' });
      } catch {
        format = info.chooseFormat({ type: 'audio', quality: 'best' });
      }
      const url = await format.decipher(yt.session.player);
      if (!url) throw new Error('Không có URL');
      const entry = {
        url,
        mime: (format.mime_type || 'audio/mp4').split(';')[0],
        exp: Date.now() + 30 * 60 * 1000,
      };
      urlCache.set(id, entry);
      console.log(`✔ ${id} lấy được bằng client ${client}`);
      return entry;
    } catch (e) {
      errs.push(`${client}: ${e.message}`);
      console.warn(`✘ ${id} client ${client}: ${e.message}`);
    }
  }
  throw new Error(errs.join(' | ') || 'Không lấy được audio');
}

// 3. Proxy stream (hỗ trợ Range để tua bài)
app.get('/api/stream/:id', async (req, res) => {
  const { id } = req.params;
  const ac = new AbortController();
  res.on('close', () => ac.abort());

  try {
    let audio = await resolveAudio(id);

    const fetchUpstream = (a) =>
      fetch(a.url, {
        headers: {
          Range: req.headers.range || 'bytes=0-',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        },
        signal: ac.signal,
      });

    let upstream = await fetchUpstream(audio);

    // link hết hạn/bị từ chối -> xoá cache, lấy link mới 1 lần
    if (upstream.status === 403 || upstream.status === 410) {
      urlCache.delete(id);
      audio = await resolveAudio(id);
      upstream = await fetchUpstream(audio);
    }

    if (!upstream.ok && upstream.status !== 206) {
      throw new Error(`YouTube trả về ${upstream.status}`);
    }

    res.status(upstream.status);
    res.setHeader('Content-Type', audio.mime);
    res.setHeader('Accept-Ranges', 'bytes');
    for (const h of ['content-length', 'content-range']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }

    Readable.fromWeb(upstream.body).on('error', () => res.end()).pipe(res);
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('Lỗi phát nhạc:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Không thể phát bài này', detail: err.message });
    else res.end();
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Server chạy ở cổng ${PORT}`));