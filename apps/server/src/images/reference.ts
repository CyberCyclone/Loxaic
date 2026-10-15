/**
 * Image references: parsing, normalising, and the registry each one is pulled
 * from. Pure.
 *
 * The rules are Docker's own (distribution/reference): a first path component
 * containing a "." or ":" or equal to "localhost" is a registry host, anything
 * else is a Docker Hub repository, and a Hub repository with one component
 * lives under "library/". Normalising matters for more than tidiness: the
 * registry decides which login is used, so `ubuntu` and
 * `docker.io/library/ubuntu` must be one image with one login.
 */

export interface ImageReference {
  /** Normalised registry host: `docker.io`, `ghcr.io`, `localhost:5000`. */
  registry: string;
  /** Path within the registry: `library/ubuntu`, `owner/image`. */
  repository: string;
  /** Null only when the reference is pinned by `digest`. */
  tag: string | null;
  digest: string | null;
}

export class ReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferenceError";
  }
}

const DOCKER_HUB = "docker.io";
const HUB_ALIASES = new Set(["docker.io", "index.docker.io", "registry-1.docker.io"]);
const PATH_COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const HOST = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*(?::[0-9]{1,5})?$/;
const TAG = /^[\w][\w.-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
/** Docker's own ceiling on a repository name. */
const MAX_NAME = 255;

export function parseReference(input: unknown): ImageReference {
  if (typeof input !== "string") throw new ReferenceError("An image reference must be text.");
  const raw = input.trim();
  if (raw.length === 0) throw new ReferenceError("Enter an image reference, such as ubuntu:24.04.");
  if (raw.length > 512 || /\s/.test(raw)) throw new ReferenceError("An image reference cannot contain spaces.");
  if (raw.includes("://")) {
    throw new ReferenceError("Leave out the scheme: write ghcr.io/owner/image, not https://ghcr.io/owner/image.");
  }

  let rest = raw;
  let digest: string | null = null;
  const at = rest.indexOf("@");
  if (at !== -1) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!DIGEST.test(digest)) throw new ReferenceError("A digest must be sha256: followed by 64 hex characters.");
  }

  // A tag's colon comes after the last slash; one before it is a port.
  let tag: string | null = null;
  const colon = rest.lastIndexOf(":");
  if (colon > rest.lastIndexOf("/")) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!TAG.test(tag)) throw new ReferenceError(`"${tag}" is not a valid tag.`);
  }

  const parts = rest.split("/");
  let registry = DOCKER_HUB;
  const first = parts[0] ?? "";
  if (parts.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost")) {
    if (!HOST.test(first)) throw new ReferenceError(`"${first}" is not a valid registry host.`);
    registry = HUB_ALIASES.has(first.toLowerCase()) ? DOCKER_HUB : first.toLowerCase();
    parts.shift();
  }
  if (parts.length === 0 || parts.some((p) => !PATH_COMPONENT.test(p))) {
    throw new ReferenceError("Image names use lowercase letters, digits, and . _ - separators between / parts.");
  }
  if (registry === DOCKER_HUB && parts.length === 1) parts.unshift("library");
  const repository = parts.join("/");
  if (repository.length > MAX_NAME) throw new ReferenceError("That image name is too long.");

  return { registry, repository, tag: tag ?? (digest ? null : "latest"), digest };
}

/** The canonical text of a reference: what is stored and shown. */
export function formatReference(ref: ImageReference): string {
  const name = `${ref.registry}/${ref.repository}`;
  if (ref.digest) return `${name}${ref.tag ? `:${ref.tag}` : ""}@${ref.digest}`;
  return `${name}:${ref.tag ?? "latest"}`;
}

/** `registry/repository`, with no tag or digest: what a pinned `@digest` is
 * appended to. */
export function repositoryName(ref: ImageReference): string {
  return `${ref.registry}/${ref.repository}`;
}

/** What the engine authenticates against for this registry. Docker Hub's
 * login endpoint is its historical v1 index, not `docker.io`. */
export function serverAddress(registry: string): string {
  return registry === DOCKER_HUB ? "https://index.docker.io/v1/" : registry;
}

/** Normalises a registry host as typed for a login (`ghcr.io`,
 * `https://index.docker.io/v1/`, `localhost:5000`). */
export function parseRegistry(input: unknown): string {
  if (typeof input !== "string") throw new ReferenceError("A registry must be text.");
  let raw = input.trim().toLowerCase();
  raw = raw.replace(/^https?:\/\//, "").replace(/\/v[12]\/?$/, "").replace(/\/+$/, "");
  // Never a default: an empty registry read as Docker Hub would send a login
  // meant for another registry there.
  if (raw.length === 0) throw new ReferenceError("Name the registry the login is for (docker.io for Docker Hub).");
  if (!HOST.test(raw)) throw new ReferenceError(`"${input.trim()}" is not a registry host, such as ghcr.io.`);
  return HUB_ALIASES.has(raw) ? DOCKER_HUB : raw;
}
