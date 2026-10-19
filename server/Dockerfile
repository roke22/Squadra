# Build from the repository root (it also ships squadra-host, which the server
# hands out to the machines you add):
#   docker build -f server/Dockerfile -t squadra-server .
FROM node:22-slim
WORKDIR /app
COPY server/server.js server/acme.js server/ws.js server/ui.html server/package.json ./
COPY host/squadra-host.mjs ./
COPY install ./install
COPY server/vendor ./vendor
# Listen on every interface inside the container. The port depends on the mode:
# 7787 for plain HTTP, 443 (+80 for certificates) with --domain / SQUADRA_DOMAIN.
ENV HOST=0.0.0.0 DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 7787 80 443
USER node
CMD ["node", "server.js"]
