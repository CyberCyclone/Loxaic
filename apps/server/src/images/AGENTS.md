# apps/server/src/images

Custom sandbox images (#253): registry logins (`logins.ts`), image rows and their pulls (`store.ts`, `pull.ts`), the check that an image can run Loxaic's tools (`check.ts`), and who may manage or use what (`access.ts`). Rules here cover keeping one person's private image and login out of everyone else's reach on a shared engine.

## Never share a login or a private image

- Create a container only from an image row's own `digest` (`repo@sha256:…`), never from a tag or reference: a pull always asks the registry, so the digest is what that row's own login proved access to. An image someone else pulled is on disk for anyone who names it.
- Never skip a pull because the image is already local; that is the shortcut that hands one person's private image to another.
- Pull a personal row with its owner's logins only and a shared row with the deployment's (null-owner) logins only. `logins.ts`'s `authFor` is the only decrypt site, and it takes exactly one owner.
- A conversation's image is checked against its *owner* (`useRefusal`), never the sender; re-check at sandbox creation, since the row, the policy and the sandbox mode can all change after the workspace was made.
- Personal routes have no admin bypass; an admin's own images are as private as anyone's.
- Never `rmi` when a row is deleted: the content may back another row. So keep the caps at the front door (`MAX_PERSONAL_IMAGES`, `MAX_PULLS_PER_OWNER`); deleting rows frees no disk.
- Read anything decided about an image (labels, its config) from the pinned digest, never the tag: the tag is shared with every row that names it and another pull can move it.
- Never default a login's registry: an empty one read as Docker Hub sends another registry's secret there.
- Custom images are Docker only (`customImagesBlocked`): Podman's compat API may fall back to the host user's own registry login when a pull sends none. Never run `docker login` on a machine whose engine serves sandboxes, tests included.

## Running a stranger's image

- Override `Entrypoint` (`tail -f /dev/null`) and `Healthcheck` (`NONE`) and keep the image's user and `ENV`; never drop `CapDrop: ALL` or `no-new-privileges` for one.
- The only device a sandbox gets is `/dev/kvm`, from a shared image's admin-set `limits.kvm` (#320); never pass another device, a capability or a socket, and never let a personal image or a request set it.
- Make `/home/loxaic/repo` with `putArchive` before start, owned by the uid:gid the check found; Docker otherwise creates a missing `WorkingDir` owned by root.
- Refuse an image carrying `loxaic.*` labels: a container inherits them, and `loxaic.executor` hides it from the orphan sweep.
- Keep `check.ts`'s required list in step with what the tools run unconditionally (the exec wrapper, the file tools, checkpoints, instruction and skill reads); a missing tool breaks a run silently.
- A failed pull leaves the last good `digest` and `check` usable; usability is "digest present and check passed", never the latest `status`.

## Changing a conversation's image

- `workspace.image` is the only part of a workspace that changes after creation, and only through `replaceConversationSandbox` under the conversation's claim (the route answers 409 while anything runs). Owner only.
- Change nothing until the new container holds the copied home and has been checked: the workspace, both rows and the active entry change together after that, and a failure destroys only the new container.
- Copy through the archive API (`copyHome`), re-owned and with setuid bits cleared (`archive-rewrite.ts`); never extract on the host, and race the upload against the stream's error, or a failed read hangs it.

## Tests

- `registry.test.ts` runs against a real `registry:2` on a fixed loopback port (Docker Desktop's engine cannot reach an ephemeral published one). Keep it gated on a reachable Docker engine only, so it runs in CI.
