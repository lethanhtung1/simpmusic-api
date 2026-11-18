FROM node:20-slim

# yt-dlp (bản standalone, không cần Python)
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV YTDLP_PATH=/usr/local/bin/yt-dlp
ENV JS_RUNTIME=node

# Mỗi lần khởi động tự cập nhật yt-dlp rồi chạy server
CMD ["sh", "-c", "yt-dlp -U || true; node server.js"]