# The Studywise course marketplace, for hosting your own.
#
#   docker compose up -d
#   docker compose exec studywise-server node manage.js add-user yourname --owner
#
# Put something that does HTTPS in front of port 3005 (Caddy, nginx, Traefik,
# a Cloudflare tunnel). Everything it keeps is in /data.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3005 \
    DATA_DIR=/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.js manage.js ./
COPY lib ./lib
COPY public ./public

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3005

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3005/api/stats >/dev/null || exit 1

CMD ["node", "server.js"]
