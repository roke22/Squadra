# Squadra demo: the dashboard and one machine that runs Claude Code, in a
# single container. Everything it keeps (the dashboard's data, the machine's
# credential, Claude Code's login and the projects) lives in one folder.
#
# From deploy/demo (it builds this image):
#   docker-compose up -d
#
# Not for production: there the dashboard and the machines run apart (see the
# README). This is for trying Squadra out on one computer.
FROM node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da

ARG CLAUDE_CODE_VERSION=latest
RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux git ca-certificates procps less \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && npm cache clean --force

WORKDIR /app
COPY server ./
COPY host/squadra-host.mjs* ./
COPY install ./install
# The plugin from this repository, as a local marketplace (not a published
# release), with an id of its contents to reinstall it when the image changes.
COPY .claude-plugin /opt/squadra/.claude-plugin
COPY plugins /opt/squadra/plugins
RUN cd /opt/squadra && find . -type f | sort | xargs sha256sum | sha256sum | cut -c1-16 > /opt/squadra/build-id
COPY deploy/demo/example /opt/squadra-example
COPY deploy/demo/entrypoint.sh deploy/demo/start.sh /usr/local/bin/

# Claude Code is updated by rebuilding the image (it can't update itself here).
ENV SQUADRA_DIR=/squadra DISABLE_AUTOUPDATER=1
VOLUME /squadra
EXPOSE 7787
ENTRYPOINT ["entrypoint.sh"]
