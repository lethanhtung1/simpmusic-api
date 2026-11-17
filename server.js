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

// 2. Endpoint phát nhạc (Sử dụng cơ chế truyền trực tiếp URL stream đã giải mã)
app.get('/api/stream/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!yt) yt = await Innertube.create();

    const info = await yt.getBasicInfo(id);
    
    // Lấy link stream âm thanh chất lượng tốt nhất
    const format = info.chooseFormat({ type: 'audio', quality: 'best' });
    if (!format || !format.url) {
      return res.status(404).json({ error: 'Không tìm thấy nguồn phát' });
    }

    const streamUrl = format.decipher(yt.session.player);
    
    // Redirect thẳng trình duyệt đến link stream gốc của YouTube (giúp giảm tải cho server Render và chạy mượt 100%)
    res.redirect(streamUrl);
  } catch (err) {
    console.error("Lỗi phát nhạc:", err);
    res.status(500).json({ error: 'Không thể phát bài này' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Server chạy ở cổng ${PORT}`));