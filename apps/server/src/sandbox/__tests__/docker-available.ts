import { getSandboxProvider } from "../provider.ts";

/**
 * Whether a container engine is actually reachable *and* the sandbox image is
 * already built.
 *
 * Both halves matter. `ensureImage()` builds `loxaic-sandbox` from scratch on
 * first use, which takes far longer than any sane hook timeout — so on a cold
 * CI runner this suite doesn't fail because the code is wrong, it fails
 * because a multi-minute image build was started inside a `beforeAll`. Skipping
 * honestly is better than a red check that says nothing about the change, and
 * better than a longer timeout that just moves the cliff.
 *
 * To run these in CI, build the image in a workflow step first; they then find
 * it present and execute normally.
 *
 * The tag matters, not just the name. Tags are a content hash of the
 * Dockerfile (see sandboxImage()), so after any change to it the *old* image
 * is still present under its old tag while the one these tests need has never
 * been built — which is exactly when a "loxaic-sandbox exists" check would
 * wave the suite through into the multi-minute build this exists to avoid.
 * Editing that Dockerfile for #62 is the first time that has come up.
 */
export async function sandboxImageReady(): Promise<boolean> {
  try {
    const provider = await getSandboxProvider();
    if (provider?.kind !== "container") return false;
    const { ok } = await provider.available();
    if (!ok) return false;
    const { sandboxImage } = await import("../container-provider.ts");
    const docker = await import("dockerode");
    const engine = new docker.default();
    const images = await engine.listImages({ filters: { reference: [sandboxImage()] } });
    return images.length > 0;
  } catch {
    return false;
  }
}
