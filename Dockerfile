FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY public/ ./public/
COPY src/ ./src/
ENV PORT=80 DATABASE_PATH=/data/ambulando.sqlite NODE_ENV=production
VOLUME ["/data"]
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:80/health || exit 1
CMD ["bun", "src/server.ts"]
