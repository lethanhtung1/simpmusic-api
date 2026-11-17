import express from 'express';
import cors from 'cors';
import { Innertube } from 'youtubei.js';

const app = express();
app.use(cors());

let yt;
(async () => {
  try {
    yt = await Innertube.create();
    console.log('✅ InnerTube đã sẵn sàng!');
  } catch (err) {
    console.error('Lỗi khởi tạo InnerTube:', err);
  }
})();

// 1. Endpoint tìm kiếm bài hát
app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.json([]);

    if (!yt) yt = await Innertube.create();
    const search = await yt.search(q, { type: 'video' });
    const songs = search.results
      .filter(item => item.type === 'Video')
      .map((item) => ({
        id: item.id,
        title: item.title?.text || item.title,
        artist: item.author?.name || 'Unknown',
        thumbnail: item.thumbnails?.[0]?.url || '',
      }));

    res.json(songs);
  } catch (err) {
    console.error("Lỗi tìm kiếm:", err);
    res.status(500).json({ error: err.message });
  }
});

// 2. Endpoint Stream dùng yt.download chính hãng
app.get('/api/stream/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!yt) yt = await Innertube.create();

    res.setHeader('Content-Type', 'audio/webm');
    
    // Tải và truyền luồng âm thanh tối ưu bằng youtubei.js
    const stream = await yt.download(id, {
      type: 'audio',
      quality: 'best',
      format: 'any'
    });

    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();

  } catch (err) {
    console.error("Lỗi phát nhạc:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Không thể phát bài này' });
    }
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Server chạy ở cổng ${PORT}`));