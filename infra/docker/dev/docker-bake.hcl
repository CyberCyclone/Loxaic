# Builds loxaic-dev (#320) on top of the real sandbox image. Run from the
# repository root:
#   docker buildx bake -f infra/docker/dev/docker-bake.hcl
# CI (.github/workflows/dev-image.yml, through ci-build.sh) sets TAGS to
# loxaic-dev:local plus the GHCR tags, loads the image, selftests it as
# loxaic-dev:local, and only then pushes the GHCR tags.

variable "TAGS" {
  default = "loxaic-dev:local"
}

group "default" {
  targets = ["dev"]
}

target "sandbox" {
  context    = "infra/docker"
  dockerfile = "sandbox.Dockerfile"
  platforms  = ["linux/amd64"]
}

target "dev" {
  context    = "infra/docker/dev"
  dockerfile = "Dockerfile"
  contexts = {
    sandbox = "target:sandbox"
  }
  platforms = ["linux/amd64"]
  tags      = split(",", TAGS)
}
