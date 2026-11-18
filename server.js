import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { Innertube, UniversalCache } from 'youtubei.js';

const execFileP = promisify(execFile);
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const JS_RUNTIME = process.env.JS_RUNTIME; // vd: node (trong Docker), để trống nếu máy có deno

// Cookies (Render: thêm Secret File tên cookies.txt -> /etc/secrets/cookies.txt)
const COOKIE_SRC = process.env.COOKIES_FILE || '/etc/secrets/cookies.txt';
let cookiePath = null;
try {
  if (fs.existsSync(COOKIE_SRC)) {
    cookiePath = path.join(os.tmpdir(), 'yt-cookies.txt');
    fs.copyFileSync(COOKIE_SRC, cookiePath); // copy vì yt-dlp có thể ghi lại file
    console.log('🍪 Đang dùng cookies YouTube');
  }
} catch (e) {
  console.warn('Không đọc được cookies:', e.message);
}

const app = express();
app.use(cors({ exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'] }));

// ---------- Tìm kiếm (youtubei.js) ----------
let ytPromise;
function getYT() {
  if (!ytPromise) {
    ytPromise = Innertube.create({ cache: new UniversalCache(false) }).catch((e) => {
      ytPromise = null;
      throw e;
    });
  }
  return ytPromise;
}
getYT().then(() => console.log('✅ InnerTube đã sẵn sàng!')).catch((e) => console.error('Lỗi khởi tạo InnerTube:', e));

app.get('/health', (_req, res) => res.send('ok'));

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
    if (process.env.PREFETCH !== '0') {
      for (const sg of songs.slice(0, 3)) resolveAudio(sg.id).catch(() => {});
    }
  } catch (err) {
    console.error('Lỗi tìm kiếm:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Lấy link audio bằng yt-dlp ----------
const urlCache = new Map(); // id -> { url, headers, mime, exp }
const inflight = new Map(); // id -> Promise (gộp các request cùng bài)
const MIME = { m4a: 'audio/mp4', mp4: 'audio/mp4', webm: 'audio/webm', opus: 'audio/ogg', mp3: 'audio/mpeg' };

// Giới hạn số yt-dlp chạy cùng lúc
const MAX_PARALLEL = 3;
let active = 0;
const waiting = [];
function limit(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      active++;
      try { resolve(await fn()); } catch (e) { reject(e); }
      finally { active--; const next = waiting.shift(); if (next) next(); }
    };
    if (active < MAX_PARALLEL) run(); else waiting.push(run);
  });
}

async function runYtdlp(id, attempt = 0) {
  const t0 = Date.now();
  const { stdout } = await execFileP(
    YTDLP,
    [
      '-f', 'bestaudio[ext=m4a]/bestaudio',
      '-j', '--no-playlist', '--no-warnings',
      ...(JS_RUNTIME ? ['--js-runtimes', JS_RUNTIME] : []),
      ...(cookiePath && attempt === 0 ? ['--cookies', cookiePath] : []),
      ...(attempt === 0
        ? (process.env.YT_CLIENT ? ['--extractor-args', `youtube:player_client=${process.env.YT_CLIENT}`] : [])
        : ['--extractor-args', 'youtube:player_client=tv,android_vr']),
      `https://www.youtube.com/watch?v=${id}`,
    ],
    { maxBuffer: 20 * 1024 * 1024, timeout: 40000 }
  );
  const j = JSON.parse(stdout);
  if (!j.url) throw new Error('yt-dlp không trả về URL');
  console.log(`✔ ${id} yt-dlp mất ${((Date.now() - t0) / 1000).toFixed(1)}s (${j.ext}, ${j.abr || '?'}kbps)`);
  // link googlevideo có tham số expire (giây); cache tới gần lúc đó
  const m = /[?&]expire=(\d+)/.exec(j.url);
  const exp = m
    ? Math.max(Number(m[1]) * 1000 - 15 * 60 * 1000, Date.now() + 5 * 60 * 1000)
    : Date.now() + 20 * 60 * 1000;
  return {
    url: j.url,
    headers: j.http_headers || {},
    mime: MIME[j.ext] || 'audio/mp4',
    exp,
  };
}

function shortErr(e) {
  const lines = String(e.stderr || e.message || '').trim().split('\n').filter(Boolean);
  return (lines[lines.length - 1] || 'lỗi không rõ').slice(0, 300);
}

async function resolveWithRetry(id) {
  let e1;
  try {
    return await limit(() => runYtdlp(id, 0));
  } catch (e) {
    e1 = e;
    console.warn(`↻ ${id} lần 1 (có cookies) lỗi: ${shortErr(e)}`);
  }
  try {
    return await limit(() => runYtdlp(id, 1));
  } catch (e2) {
    console.warn(`✘ ${id} lần 2 (không cookies) lỗi: ${shortErr(e2)}`);
    throw new Error(`Lần 1: ${shortErr(e1)} | Lần 2: ${shortErr(e2)}`);
  }
}

function resolveAudio(id) {
  const hit = urlCache.get(id);
  if (hit && hit.exp > Date.now()) return Promise.resolve(hit);
  if (inflight.has(id)) return inflight.get(id);
  const p = resolveWithRetry(id)
    .then((entry) => { urlCache.set(id, entry); return entry; })
    .finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

// Tải trước link cho bài sắp phát (frontend gọi khi bài hiện tại đang chạy)
app.get('/api/prefetch/:id', (req, res) => {
  const { id } = req.params;
  if (!/^[\w-]{11}$/.test(id)) return res.sendStatus(400);
  res.sendStatus(202);
  resolveAudio(id).catch(() => {});
});

// ---------- Proxy stream, hỗ trợ Range ----------
app.get('/api/stream/:id', async (req, res) => {
  const { id } = req.params;
  if (!/^[\w-]{11}$/.test(id)) return res.status(400).json({ error: 'ID không hợp lệ' });

  const ac = new AbortController();
  res.on('close', () => ac.abort());

  try {
    const doFetch = (a) =>
      fetch(a.url, {
        headers: { ...a.headers, Range: req.headers.range || 'bytes=0-' },
        signal: ac.signal,
      });

    let audio = await resolveAudio(id);
    let upstream = await doFetch(audio);

    if (upstream.status === 403 || upstream.status === 410) {
      urlCache.delete(id);
      audio = await resolveAudio(id);
      upstream = await doFetch(audio);
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
    console.error('Lỗi phát nhạc:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Không thể phát bài này', detail: err.message });
    else res.end();
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Server chạy ở cổng ${PORT}`));