# syntax=docker/dockerfile:1.7

# The container action image of the `filters-agent` action face: the sources, node_modules and
# both browsers in one image, booted through tsx. There is no build step and no bundle; the
# repository ships sources, so a `src/` change is an image change by construction. The browser
# presence check (`src/action/action-main.ts`) never downloads: everything it probes is installed
# here, and the final proof of each browser is a real headless launch at build time — a launched
# browser is the capability, its installed files are not (`ldd` and directory listings assert
# prerequisites, not the capability).

# The sources the image runs, without the AdGuard CLI module: src/adguard-cli/ ships as the
# separately installed blocker module (`adguard-cli/`), so the image carries the browser extension
# route and the generic module executor, and nothing that knows the CLI. Pruning in its own stage
# keeps the module's files out of every layer of the final image, not just its top layer.
FROM node:24-bookworm-slim AS sources
COPY src/ /sources/src/
RUN rm -rf /sources/src/adguard-cli

FROM node:24-bookworm-slim

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# The run-time vocabulary of the action face: `CLOAKBROWSER_AUTO_UPDATE=false` turns the browser
# presence check (`src/action/action-main.ts`) into a named failure instead of a silent download;
# the headless/no-sandbox pair matches the config's own semantics (`NO_SANDBOX` is read there, and
# container runs execute as root); both browser caches resolve against image-owned directories, so
# no launch ever looks at a user home.
ENV CLOAKBROWSER_CACHE_DIR=/opt/cloakbrowser \
    CLOAKBROWSER_AUTO_UPDATE=false \
    HEADLESS=true \
    NO_SANDBOX=true \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

RUN corepack enable \
    && corepack prepare pnpm@10.33.4 --activate

# Every run clones or fetches the filters checkout through this git, and the pinned extension
# release unpacks through unzip; `safe.directory` covers the mounted checkout, which belongs to
# the runner user while the container runs as root. The round-trip proves both tools by
# capability, not by installation: git writes a real archive and unzip must decompress and
# CRC-check it, so a broken tool fails the build instead of the first run. `git archive
# --format=zip` uses git's built-in zip writer, so no `zip` package is added.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git unzip ca-certificates curl jq \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system --add safe.directory '*' \
    && git init /tmp/git-proof \
    && printf 'proof' > /tmp/git-proof/proof.txt \
    && git -C /tmp/git-proof add proof.txt \
    && git -C /tmp/git-proof -c user.name=proof -c user.email=proof@localhost commit -m proof \
    && git clone --no-checkout /tmp/git-proof /tmp/git-clone \
    && git -C /tmp/git-proof archive --format=zip HEAD > /tmp/git-proof.zip \
    && unzip -t /tmp/git-proof.zip \
    && rm -rf /tmp/git-proof /tmp/git-clone /tmp/git-proof.zip

COPY package.json pnpm-lock.yaml tsconfig.json ./

# No `pnpm store prune` here on purpose: node_modules lives on the layer while the store rides
# the cache mount, so cross-filesystem imports fall back to copies, every store file keeps
# nlink 1, and nlink-based pruning would wipe the store it just populated. The mount is bounded
# by the builder-cache retention budget instead (cache mounts are LRU-evicted like any other
# builder-cache record).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store

# Chromium's system libraries first, then the pinned binary from the lockfile, then the proof:
# the launch runs with the same env-resolved cache the action's browser executor uses at run
# time, with the root-safe flags a container launch needs.
RUN pnpm exec playwright-core install-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# The binary comes straight from CloakHQ's release channel, on the runner that builds this image,
# and it is not MIT: the CloakBrowser Binary License allows using it and forbids redistributing
# it. An image built from this recipe therefore stays where it was built — do not push it to a
# public registry, and do not move this layer into a published base image.
RUN pnpm exec cloakbrowser install

RUN node --input-type=module -e "import { launch } from 'cloakbrowser'; const browser = await launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] }); console.log('cloakbrowser chromium ready:', browser.version()); await browser.close();"

# Firefox is the second executor (`src/browser/firefox-engine.ts` launches it through
# playwright-core): its browsers live under PLAYWRIGHT_BROWSERS_PATH, because inside a container
# action `HOME` is `/github/home` and the default cache would not survive the run. The proof
# launches the installed build headless and closes it.
RUN pnpm exec playwright-core install-deps firefox \
    && rm -rf /var/lib/apt/lists/* \
    && pnpm exec playwright-core install firefox

RUN node --input-type=module -e "import { firefox } from 'playwright-core'; const browser = await firefox.launch({ headless: true }); console.log('playwright firefox ready:', browser.version()); await browser.close();"

# Sources only (the pruned tree from the `sources` stage), never the tests; tsconfig.json (copied
# above) travels with them because tsx resolves the module graph through it.
COPY --from=sources /sources/src/ ./src/

# The boot command, written once: the ENTRYPOINT runs this file and the boot proof below runs the
# very same file, so the proof can never drift from what GitHub starts. It changes into the mounted
# checkout for the run's own path semantics (relative `instructionPath`, artifacts under the
# checkout) when `GITHUB_WORKSPACE` is bound; the change is skipped only when it is unset or empty,
# where the binding (`src/action/action-input-binding.ts`) fails named from `/app`, and a bound but
# missing directory makes `cd` fail loudly under `set -e`. Then it boots the entry through tsx — the
# loader by absolute path, because the checkout has no node_modules, and nothing compiled.
RUN cat > /app/boot.sh <<'BOOT'
#!/bin/sh
set -e
if [ -n "${GITHUB_WORKSPACE:-}" ]; then cd "$GITHUB_WORKSPACE"; fi
exec node --import /app/node_modules/tsx/dist/loader.mjs /app/src/action/action-main.ts
BOOT
RUN chmod 0755 /app/boot.sh

# Boot proof: start the face exactly as GitHub does, with a bound workspace and none of the action's
# inputs, and require the named failure that lists every mandatory input. A wrong loader path, a
# module that no longer resolves inside the image, or a face that boots without its inputs fails
# the build here instead of the first real action run. It runs at build time so that a builder
# without a daemon to `docker run` the image (a remote BuildKit builder, for one) still proves it.
RUN mkdir -p /tmp/boot-proof \
    && if out="$(GITHUB_WORKSPACE=/tmp/boot-proof /app/boot.sh 2>&1)"; then \
        printf '%s\n' "$out"; echo 'boot proof: the face booted cleanly without its inputs'; exit 1; \
    fi \
    && printf '%s\n' "$out" \
    && for problem in 'Run mode is required' 'Repository identity is required' 'llm.baseUrl'; do \
        grep -qF -- "$problem" <<<"$out" || { echo "boot proof: the failure does not name: $problem"; exit 1; }; \
    done \
    && rm -rf /tmp/boot-proof

ENTRYPOINT ["/app/boot.sh"]
