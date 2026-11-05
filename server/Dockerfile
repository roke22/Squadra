# Build from the repository root (it also ships squadra-host, which the server
# hands out to the machines you add):
#   docker build -f server/Dockerfile -t squadra-server .
FROM node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
WORKDIR /app
COPY server ./
COPY host/squadra-host.mjs* ./
COPY install ./install
# Listen on every interface inside the container. The port depends on the mode:
# 7787 for plain HTTP, 443 (+80 for certificates) with --domain / SQUADRA_DOMAIN.
ENV HOST=0.0.0.0 DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 7787 80 443
USER node
CMD ["node", "server.js"]
