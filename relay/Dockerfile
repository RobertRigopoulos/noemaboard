# Noema relay: optional always-on, end-to-end encrypted sync server.
#   docker build -t noema-relay .
#   docker run -d --name relay -p 8787:8787 -v noema-relay:/data --restart unless-stopped noema-relay
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY bin ./bin
COPY src ./src

# Run as the unprivileged "node" user; /data holds the database and encrypted files.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

STOPSIGNAL SIGTERM
CMD ["node", "bin/noema-relay.js"]
