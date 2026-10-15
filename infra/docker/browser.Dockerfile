# The browsing image (#281): one headless Chromium per conversation.
#
# Deliberately a separate image from sandbox.Dockerfile rather than another
# layer on top of it. A sandbox is a long-lived coding session's working
# directory that is paused, resumed and checkpointed; a browser is destroyed on
# every teardown and has nothing a checkout needs. Adding ~300 MB of Chromium to
# the sandbox image would make every sandbox slower to build and heavier to run
# for a capability most conversations never use, and it would put the browser in
# the same container as the model's shell — where a page exploit lands next to
# the user's repo and credentials.
#
# The base is Microsoft's Playwright image rather than a hand-rolled Chromium
# install: it is the one place Chromium's exact shared-library dependencies, its
# font set and its headless-shell expectations are maintained and tested against
# every release, and reproducing that here would be a permanent tail. It is
# pinned by digest, not tag, because what runs in here is decided by model-
# directed web pages; a tag moving under us would change the browser a
# deployment uses without any commit saying so.
#
# To move versions: `docker buildx imagetools inspect
# mcr.microsoft.com/playwright:v<X.Y.Z>-noble` for the digest, and keep
# `PLAYWRIGHT_VERSION` in apps/server/src/browser/container.ts matching the tag
# part — the driver (playwright-core, pinned in apps/server/package.json) and
# the browser must be the same minor, or connectOverCDP fails in ways that look
# like a broken session rather than a version mismatch.
ARG PLAYWRIGHT_BASE_IMAGE=mcr.microsoft.com/playwright@sha256:7852dc5a7d72f5fe458a597d690f6c42fbc8e9e26ddfa95f8e6ef552558d9bbf
FROM ${PLAYWRIGHT_BASE_IMAGE}

# The Playwright image runs as root and its Chromium is launched with
# --no-sandbox (see browser/launch.ts for why Docker is the containment here).
# uid 1001 matches the sandbox image's user so the two look the same from the
# host's point of view. No home directory contents and nothing mounted in: the
# browser profile is a tmpfs created at container start, so this user's home
# holds nothing but the empty directory Chromium is told to use.
RUN useradd -m -s /bin/bash loxaic && mkdir -p /home/loxaic/profile && chown -R loxaic:loxaic /home/loxaic

USER loxaic
WORKDIR /home/loxaic

# The launcher, not Chromium itself: `tail` keeps the container up so the
# manager can start Chromium once per session with the flags the session needs
# (proxy address, resolver rules) rather than baking them into the image. The
# proxy's port is only known once the server is listening, so it cannot be an
# image-level constant.
CMD ["tail", "-f", "/dev/null"]
