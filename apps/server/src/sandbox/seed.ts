import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { SandboxHandle } from "./provider.ts";

async function collectFiles(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(abs, base)));
    else if (entry.isFile()) files.push(path.relative(base, abs));
    else {
      // Anything else — most plausibly a symlink — would otherwise vanish
      // from the seeded sandbox with no error, leaving the agent to fail
      // against a fixture that silently isn't what the directory looked
      // like. Refuse rather than half-copy.
      throw new Error(
        `seedSandbox: ${abs} is neither a regular file nor a directory (symlinks are not supported)`,
      );
    }
  }
  return files;
}

/**
 * Copies every file under `sourceDir` into a freshly-created sandbox's
 * working directory, for the real-model e2e suite's seeded-repo scenario
 * (apps/e2e/fixtures/seeded-app/) — see E2E_SANDBOX_SEED_DIR in
 * sandbox-manager.ts's createEntry().
 *
 * Goes through SandboxHandle.writeFile() rather than a provider-specific
 * bulk-copy (tar + dockerode's putArchive for containers, a plain fs copy
 * for host) so this works identically for either provider with no branch on
 * `handle.provider` — the fixture is a handful of small text files, so the
 * one-write-per-file cost is irrelevant next to that simplicity.
 */
export async function seedSandbox(handle: SandboxHandle, sourceDir: string): Promise<void> {
  const relPaths = await collectFiles(sourceDir);
  for (const rel of relPaths) {
    // SandboxHandle.writeFile takes a string, so anything that doesn't
    // survive a UTF-8 round-trip (an image, a font, a compiled binary) would
    // be written back subtly mangled with no error at all. Refuse instead:
    // silent corruption inside a sandbox is far harder to diagnose than a
    // failed seed, and lifting this needs a Buffer-capable writeFile.
    const bytes = await readFile(path.join(sourceDir, rel));
    const content = bytes.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(bytes)) {
      throw new Error(`seedSandbox: ${rel} is not valid UTF-8 (binary files are not supported)`);
    }
    // The sandbox side is always POSIX (a Linux container, or a host path
    // this codebase already treats as POSIX elsewhere) regardless of the
    // OS running the harness — normalize separators explicitly rather than
    // relying on `rel` already being one or the other.
    const remotePath = path.posix.join(handle.workdir, ...rel.split(path.sep));
    await handle.writeFile(remotePath, content);
  }
}
