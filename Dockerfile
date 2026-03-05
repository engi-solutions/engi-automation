# =============================================================================
# Engi Automation — Multi-stage Dockerfile
#
# Builds the engi-automation fork from source and produces a lean runtime image.
#
# Usage:
#   docker build -t engi-automation .
#
# Build args:
#   NODE_VERSION  — Node.js version (default 22.16.0)
#   PNPM_VERSION  — pnpm version (default 10.22.0)
# =============================================================================

ARG NODE_VERSION=22.16.0

# =============================================================================
# Stage 1: Builder — install dependencies and compile the monorepo
# =============================================================================
FROM node:${NODE_VERSION}-alpine AS builder

ARG PNPM_VERSION=10.22.0

# System dependencies required for native modules (sqlite3, bcrypt, etc.)
RUN apk add --no-cache python3 make g++ git

# Enable corepack and activate pnpm
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /build

# Copy dependency manifests first (cache layer)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches/ patches/

# Copy all package.json files from workspace packages so pnpm can resolve the graph.
# We use a two-step approach: copy manifests → install → copy source → build.
COPY packages/cli/package.json packages/cli/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/nodes-base/package.json packages/nodes-base/package.json
COPY packages/@n8n/ packages/@n8n/
COPY packages/frontend/ packages/frontend/
COPY packages/extensions/ packages/extensions/
COPY packages/testing/ packages/testing/

# Install all dependencies (including devDependencies for build)
RUN pnpm install --frozen-lockfile

# Copy full source
COPY . .

# Build the entire monorepo via turbo
RUN pnpm build

# Generate third-party licenses (best effort)
RUN node scripts/generate-third-party-licenses.mjs || true

# Trim frontend package.json files (removes unnecessary fields for prod)
RUN node .github/scripts/trim-fe-packageJson.js || true

# Deploy n8n CLI with production-only dependencies into /compiled
RUN NODE_ENV=production DOCKER_BUILD=true \
    pnpm --filter=n8n --prod --legacy deploy --no-optional /compiled

# Copy third-party licenses into compiled output
RUN cp packages/cli/THIRD_PARTY_LICENSES.md /compiled/THIRD_PARTY_LICENSES.md 2>/dev/null || true

# =============================================================================
# Stage 2: Runtime — lean image with only compiled artifacts
# =============================================================================
FROM node:${NODE_VERSION}-alpine AS runtime

# System dependencies for runtime
RUN apk add --no-cache \
      git \
      openssh \
      openssl \
      graphicsmagick \
      tini \
      tzdata \
      ca-certificates \
      libc6-compat && \
    rm -rf /tmp/* /root/.npm

ENV NODE_ENV=production
ENV N8N_RELEASE_TYPE=custom
ENV SHELL=/bin/sh

WORKDIR /home/node

# Copy compiled n8n application
COPY --from=builder /compiled /usr/local/lib/node_modules/n8n

# Copy entrypoint script
COPY docker/images/n8n/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Rebuild native modules for the runtime image, symlink binary, setup dirs
RUN cd /usr/local/lib/node_modules/n8n && \
    npm rebuild sqlite3 && \
    ln -s /usr/local/lib/node_modules/n8n/bin/n8n /usr/local/bin/n8n && \
    mkdir -p /home/node/.n8n && \
    chown -R node:node /home/node && \
    rm -rf /root/.npm /tmp/*

EXPOSE 5678/tcp

USER node

ENTRYPOINT ["tini", "--", "/docker-entrypoint.sh"]

LABEL org.opencontainers.image.title="Engi Automation" \
      org.opencontainers.image.description="Workflow Automation by Engi" \
      org.opencontainers.image.source="https://github.com/RchrdHndrcks/engi-automation"
