# syntax=docker/dockerfile:1
#
# Task J — one image, one process, serving both the built client and the API.
#
# The Node server already serves dist/client as static files (see the
# existsSync(clientBuildPath) block in server/index.ts) and the API under /api,
# so a single process on a single port is the whole deployment. No nginx, no
# second container.
#
# Build:  docker build -t jobbeacon:latest .
# Run:    docker compose -f docker-compose.prod.yml up -d

# ---------------------------------------------------------------------------
# Stage 1 — build the client and compile the server.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

# package files first, so editing a source file does not re-download every
# dependency. This is the single biggest build-time saving in the file.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.server.json tsconfig.server.build.json vite.config.ts ./
COPY client ./client
COPY server ./server
COPY shared ./shared
COPY scripts ./scripts

# VITE_* VARIABLES ARE BUILD-TIME, NOT RUNTIME, AND THAT DISTINCTION IS THE
# WHOLE POINT OF THESE TWO LINES. Vite replaces import.meta.env.VITE_FOO with
# the literal value while bundling, so a variable supplied only by compose's
# `env_file` at container start arrives far too late — the bundle is already
# compiled and the reference is already gone. Without these ARGs the built
# client throws "Missing Supabase browser configuration" during its first
# render, React never commits, and the site serves a blank white page.
#
# ONLY PUBLIC VALUES BELONG HERE. VITE_SUPABASE_PUBLISHABLE_KEY ships to every
# browser by design, so baking it into a layer exposes nothing new. The
# service-role key must never be named VITE_* and must never be passed as a
# build arg — see docs/JOOBLE_INTEGRATION.md §3.4. There is deliberately no
# `ARG SUPABASE_SERVICE_ROLE_KEY`; the runtime-only secrets arrive via
# docker-compose.prod.yml's env_file, after this stage is finished.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ENV VITE_SUPABASE_URL=${VITE_SUPABASE_URL} \
    VITE_SUPABASE_PUBLISHABLE_KEY=${VITE_SUPABASE_PUBLISHABLE_KEY}

# Fails the image build if the TypeScript does not compile, which is the same
# fail-fast gate deploy.sh runs locally before shipping anything. It also now
# fails if the two build args above are missing: main.tsx reaches
# readSupabaseBrowserConfig() during the first render, so a bundle built
# without them is a blank page rather than a build error — this assertion is
# what turns that silent runtime failure into a loud build failure.
RUN test -n "${VITE_SUPABASE_URL}" \
 && test -n "${VITE_SUPABASE_PUBLISHABLE_KEY}" \
 || (echo "ERROR: VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY are required build args. Without them the client bundle renders a blank page. Pass them with: docker compose --env-file .env.build -f docker-compose.prod.yml build" >&2; exit 1)

RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 — production dependencies.
#
# Built as its own stage so the runtime image never contains the toolchain:
# vite, typescript, vitest and playwright's test runner are dev dependencies and
# have no business in a production container.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---------------------------------------------------------------------------
# Stage 3 — runtime.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

# HOST IS NOT OPTIONAL HERE. server/index.ts binds to process.env.HOST ?? 
# "127.0.0.1", which is the right default for a developer machine and makes the
# container UNREACHABLE the moment it is published — the port would be open on
# the host and nothing would answer. 0.0.0.0 is what lets Docker's port
# publishing reach it, and it is safe because the only thing in front of this
# container is the host's reverse proxy.
ENV NODE_ENV=production \
    PORT=5000 \
    HOST=0.0.0.0

# CHROMIUM COMES FROM ALPINE, NOT FROM PLAYWRIGHT, AND THAT IS THE WHOLE REASON
# THESE TWO VARIABLES EXIST. Playwright's managed browser builds are linked
# against glibc and do not run on musl, so "npx playwright install chromium"
# cannot work on this base image. Alpine ships its own musl-built Chromium at
# /usr/bin/chromium-browser; PLAYWRIGHT_EXECUTABLE_PATH points the resume
# renderer at it, and the launch args cover Docker's 64 MB /dev/shm, which
# Chromium crashes rendering into.
#
# VERIFIED BY RUNNING IT, NOT BY READING A REFERENCE. The first version of this
# file installed only "chromium-swiftshader", following jlandure/alpine-chrome's
# Dockerfile. That package contains the ANGLE/SwiftShader libraries
# (/usr/lib/chromium/libEGL.so and friends) and NO BROWSER BINARY at all, so
# Playwright failed with "executable doesn't exist at
# /usr/bin/chromium-browser". The "chromium" package is what provides
# /usr/bin/chromium-browser (a symlink to chromium-launcher.sh). Installing both
# was confirmed inside the running container to launch a browser and render a
# real PDF.
ENV PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    PLAYWRIGHT_LAUNCH_ARGS="--disable-dev-shm-usage --disable-software-rasterizer"

# dumb-init as PID 1 so a SIGTERM from "docker stop" reaches node instead of
# being swallowed by the shell-less exec. The server already stops on SIGTERM;
# without this it never receives it and every deploy waits out the kill timeout.
RUN apk add --no-cache \
      chromium \
      chromium-swiftshader \
      ttf-freefont \
      font-noto-emoji \
      dumb-init

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

# Non-root, and NO RECURSIVE chown. The app only ever READS these files — it
# writes nothing to disk at runtime, because resumes and every other artefact
# live in Supabase Storage — and the files COPY produces are world-readable, so
# the user needs no ownership of them. An earlier version of this file ran
# "chown -R app:app /app", which walks every one of the tens of thousands of
# files in node_modules: it added minutes to the build and stalled it outright on
# a Windows host, for a permission change nothing reads.
RUN addgroup -S app && adduser -S app -G app
USER app

EXPOSE 5000

# Uses global fetch (Node 22) rather than wget or curl, so no extra package is
# needed in the image just to answer "is it up".
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/health').then(function(r){process.exit(r.ok?0:1)}).catch(function(){process.exit(1)})"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server/server/index.js"]
