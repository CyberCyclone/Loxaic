# Metro, for Expo Go.
#
# A published EAS update cannot be opened by Expo Go — an update is built for a
# runtime version only a real build has — so the only way Expo Go can run a
# pull request's code is a live Metro dev server serving that code. That is all
# this image is: the workspace installed, `expo start` bound to every
# interface, and nothing else.
#
# Debian rather than Alpine: Metro's file watching and several of the Expo
# CLI's transitive native deps are built against glibc, and the musl variants
# fail in ways that present as an empty bundle rather than an error.
FROM node:22-bookworm-slim
WORKDIR /app

# git: `expo start` shells out to it for the project's revision, and pnpm
# resolves any git: dependency through it. Neither is present in -slim.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@latest --activate

# The whole workspace, for the same reason server.Dockerfile takes it: pnpm
# validates the lockfile against every member's package.json, so a hand-picked
# subset of COPYs leaves it unable to resolve Metro's own devDependencies.
COPY . .
RUN pnpm install --frozen-lockfile

WORKDIR /app/apps/mobile

# Metro listens on the *same* port inside the container that it is published
# on, which is why this is a variable rather than a fixed 8081. Expo hands the
# phone a bundle URL built from REACT_NATIVE_PACKAGER_HOSTNAME and its own
# listening port — it has no idea a port mapping exists — so publishing
# 42361:8081 would advertise `exp://<host>:8081` and the phone would sit there
# failing to connect to a port nothing serves.
ENV METRO_PORT=8081
EXPOSE 8081

# --host lan makes Expo advertise REACT_NATIVE_PACKAGER_HOSTNAME rather than
# localhost. Without it every URL it prints — and hands to Expo Go — is
# 127.0.0.1, which inside a container means the container itself.
CMD ["sh", "-c", "exec npx expo start --host lan --port \"$METRO_PORT\""]
