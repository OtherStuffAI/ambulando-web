FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY public/ ./public/
COPY src/ ./src/
# All state lives in the site's NStack namespace; the container filesystem is disposable.
# Required at runtime: NSTACK_APP_NSEC (app signing key), APP_SECRET_KEY (seals Stripe secrets).
ENV PORT=80 NSTACK_URL=https://nstack.otherstuff.ai NODE_ENV=production
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:80/health || exit 1
CMD ["bun", "src/server.ts"]
