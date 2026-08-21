import Docker from "dockerode";
import { v4 as uuid } from "uuid";

// Any Docker-API-compatible engine works (Docker, Podman, OrbStack, Colima).
// CONTAINER_SOCKET overrides the default /var/run/docker.sock — see docs/RUNTIME.md.
const docker = process.env.CONTAINER_SOCKET
  ? new Docker({ socketPath: process.env.CONTAINER_SOCKET })
  : new Docker();

const SANDBOX_IMAGE = "shannon-sandbox";
const DEFAULT_LIMITS = {
  Memory: 512 * 1024 * 1024, // 512MB
  NanoCpus: 1_000_000_000,   // 1 CPU
  PidsLimit: 100,
};

export type SandboxConfig = {
  limits?: {
    memory?: number;   // bytes
    cpu?: number;      // nano CPUs
    pids?: number;
  };
  repoUrl?: string;
  branch?: string;
  token?: string;
};

export type SandboxInfo = {
  id: string;
  containerId: string;
  status: string;
  repoUrl?: string;
  createdAt: string;
};

export async function createSandbox(
  userId: string,
  config: SandboxConfig = {},
): Promise<SandboxInfo> {
  const container = await docker.createContainer({
    Image: SANDBOX_IMAGE,
    Cmd: ["tail", "-f", "/dev/null"],
    HostConfig: {
      Memory: config.limits?.memory ?? DEFAULT_LIMITS.Memory,
      NanoCpus: config.limits?.cpu ?? DEFAULT_LIMITS.NanoCpus,
      PidsLimit: config.limits?.pids ?? DEFAULT_LIMITS.PidsLimit,
      AutoRemove: true,
      NetworkMode: "none",
    },
    Labels: {
      "shannon.user": userId,
      "shannon.sandbox": uuid(),
    },
  });

  await container.start();

  const info = await container.inspect();

  // Clone repo if specified
  if (config.repoUrl) {
    let url = config.repoUrl;
    if (config.token) {
      url = url.replace("https://", `https://x-access-token:${config.token}@`);
    }
    await execInContainer(container, [
      "git", "clone", "--depth=1",
      config.branch ? `--branch=${config.branch}` : "",
      url,
      "/home/shannon/repo",
    ].filter(Boolean));
  }

  return {
    id: container.id,
    containerId: container.id,
    status: info.State?.Status || "running",
    repoUrl: config.repoUrl,
    createdAt: new Date().toISOString(),
  };
}

export async function stopSandbox(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  await container.stop({ t: 10 }).catch(() => {});
  await container.remove({ force: true }).catch(() => {});
}

export async function execInContainer(
  container: Docker.Container,
  command: string[],
  options?: { workdir?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const exec = await container.exec({
    Cmd: command,
    AttachStdout: true,
    AttachStderr: true,
    WorkingDir: options?.workdir || "/home/shannon",
  });

  return new Promise((resolve, reject) => {
    exec.start({ hijack: true }, (err, stream) => {
      if (err) return reject(err);
      let stdout = "";
      let stderr = "";
      if (stream) {
        stream.on("data", (chunk: Buffer) => {
          // Docker multiplexes stdout/stderr
          // Header: [stream_type (1 byte)][0][0][0][size (4 bytes)]
          const header = chunk[0];
          const data = chunk.slice(8).toString();
          if (header === 1) stdout += data;
          else if (header === 2) stderr += data;
        });
        stream.on("end", () => resolve({ stdout, stderr, exitCode: 0 }));
        stream.on("error", reject);
      }
    });
  });
}

export async function getSandboxFileTree(
  container: Docker.Container,
  path: string = "/home/shannon",
): Promise<{ name: string; type: "file" | "dir"; path: string }[]> {
  const { stdout } = await execInContainer(container, [
    "find", path, "-maxdepth", "3", "-printf", "%y %P\n",
  ]);
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [type, relPath] = line.split(" ", 2);
      return {
        name: relPath.split("/").pop() || relPath,
        type: type === "d" ? "dir" : "file",
        path: `${path}/${relPath}`,
      };
    });
}

export async function readSandboxFile(
  container: Docker.Container,
  path: string,
): Promise<string> {
  const { stdout } = await execInContainer(container, ["cat", path]);
  return stdout;
}

export async function writeSandboxFile(
  container: Docker.Container,
  path: string,
  content: string,
): Promise<void> {
  const encoded = Buffer.from(content).toString("base64");
  await execInContainer(container, [
    "bash", "-c", `mkdir -p "$(dirname "${1}")" && echo "${2}" | base64 -d > "${1}"`,
    "_", path, encoded,
  ]);
}

export function getContainer(containerId: string): Docker.Container {
  return docker.getContainer(containerId);
}