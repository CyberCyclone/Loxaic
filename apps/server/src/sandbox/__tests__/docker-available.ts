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
 */
export async function sandboxImageReady(): Promise<boolean> {
  try {
    const provider = await getSandboxProvider();
    if (provider?.kind !== "container") return false;
    const { ok } = await provider.available();
    if (!ok) return false;
    const docker = await import("dockerode");
    const engine = new docker.default();
    const images = await engine.listImages({ filters: { reference: ["loxaic-sandbox"] } });
    return images.length > 0;
  } catch {
    return false;
  }
}
