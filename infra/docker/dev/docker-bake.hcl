# Builds loxaic-dev (#320) on top of the real sandbox image. Run from the
# repository root:
#   docker buildx bake -f infra/docker/dev/docker-bake.hcl
# CI (.github/workflows/dev-image.yml) sets TAGS and pushes.

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
