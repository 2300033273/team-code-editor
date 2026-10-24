# One container with everything: the Node server, the built React client and the
# real compilers (Python, GCC/G++, JDK). Used by Render and docker compose.

# ---------- stage 1: build the React client ----------
FROM node:22-bookworm-slim AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install
COPY client ./
RUN npm run build

# ---------- stage 2: runtime ----------
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 gcc g++ libc6-dev default-jdk-headless \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/package*.json server/
RUN cd server && npm install --omit=dev
COPY server server
COPY --from=client-build /app/client/dist client/dist

# The server starts as root only so it can hand each program run to an
# unprivileged user (RUNNER_UID). That user cannot read /app/server/data
# (users, password hashes, saved code) or the server's environment variables.
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin runner \
 && mkdir -p /app/server/data && chmod 700 /app/server/data
ENV NODE_ENV=production \
    PORT=10000 \
    RUNNER_UID=10001 \
    RUNNER_GID=10001

EXPOSE 10000
CMD ["node", "server/src/index.js"]
