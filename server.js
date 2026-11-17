import express from 'express';
import cors from 'cors';
import { Innertube } from 'youtubei.js';

const app = express();
app.use(cors()); // Cho phép Vercel gọi sang

let yt;
(async () => {
  yt = await Innertube.create();
  console.log('✅ InnerTube đã sẵn sàng!');
})();

// 1. Endpoint tìm kiếm bài hát
app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.json([]);

    const search = await yt.music.search(q, { type: 'song' });
    const songs = search.results.map((item) => ({
      id: item.id,
      title: item.title,
      artist: item.artists?.map((a) => a.name).join(', ') || 'Unknown',
      thumbnail: item.thumbnails?.[0]?.url || '',
    }));

    res.json(songs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Endpoint phát nhạc trực tiếp (Server tải từ YouTube và truyền thẳng về web)
app.get('/api/stream/:id', async (req, res) => {
  try {
    const { id } = req.params;
    res.setHeader('Content-Type', 'audio/webm'); // Định dạng âm thanh mặc định của YouTube
    
    const stream = await yt.download(id, {
      type: 'audio',
      quality: 'best',
      format: 'any'
    });

    // Chuyển đổi Web ReadableStream sang Node Stream để gửi về thẻ <audio>
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Không thể phát bài này' });
    }
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Server chạy ở cổng ${PORT}`));