#!/usr/bin/env bash
# The dev image's CI build (#320), the same for the pull request check and the
# publish from dev (.github/workflows/dev-image.yml), so the check always tests
# what is published: free the runner's disk, build with bake (TAGS names the
# tags, loxaic-dev:local first), and run the selftest under the restrictions
# Loxaic gives every sandbox. Run from the repository root.
set -euo pipefail

# The image is about 13 GB; the runner's preinstalled SDKs are not needed.
sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc /opt/hostedtoolcache/CodeQL
docker image prune -af >/dev/null
df -h /

docker buildx bake -f infra/docker/dev/docker-bake.hcl --load

docker run --rm --cap-drop ALL --security-opt no-new-privileges --network none --shm-size 64m \
  -v "$PWD/infra/docker/dev/selftest.sh:/selftest.sh:ro" loxaic-dev:local bash /selftest.sh
