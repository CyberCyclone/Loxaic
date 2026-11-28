import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * infra/proxmox/{create-lxc,install}.sh run as root on a Proxmox host and in
 * the container it makes. Every Proxmox, apt, systemd and network command is
 * a fake on PATH that logs its argv, and every absolute path the scripts
 * touch sits under LOXAIC_TEST_ROOT — so each decision the scripts make is
 * pinned here without a Proxmox host. The real run is checked by hand on one.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const INSTALL = path.join(REPO_ROOT, "infra/proxmox/install.sh");
const CREATE = path.join(REPO_ROOT, "infra/proxmox/create-lxc.sh");
const FIXTURES = path.join(HERE, "fixtures/proxmox");
const GH = "https://github.com/CyberCyclone/Loxaic";
const API = "https://api.github.com/repos/CyberCyclone/Loxaic";
const RAW = "https://raw.githubusercontent.com/CyberCyclone/Loxaic";

// Each script run spawns a few dozen fake commands: about 2 s on macOS.
const SLOW = { timeout: 30_000 };

const urlKey = (url) => url.replace(/[^A-Za-z0-9]/g, "_");

/** The logging preamble every fake shares. */
const FAKE_HEAD = `#!/bin/bash\nprintf '%s\\n' "$(basename "$0") $*" >> "$FAKE_LOG"\n`;

const CURL = `${FAKE_HEAD}
out=""; fmt=""; url=""; fail=0
while [ $# -gt 0 ]; do
  case $1 in
    -o) out=$2; shift 2 ;;
    -w) fmt=$2; shift 2 ;;
    --retry|--max-time) shift 2 ;;
    http*) url=$1; shift ;;
    --*) shift ;;
    -*) case $1 in *f*) fail=1 ;; esac; shift ;;
    *) shift ;;
  esac
done
src="$FAKE_URLS/$(printf '%s' "$url" | tr -c 'A-Za-z0-9' '_')"
if [ -f "$src" ]; then
  if [ -n "$out" ]; then cp "$src" "$out"; else cat "$src"; fi
  [ -n "$fmt" ] && printf 200
  exit 0
fi
[ -n "$fmt" ] && printf 404
[ "$fail" = 1 ] && exit 22
exit 0
`;

class Sandbox {
  constructor() {
    this.dir = mkdtempSync(path.join(os.tmpdir(), "loxaic-proxmox-"));
    this.bin = path.join(this.dir, "bin");
    this.root = path.join(this.dir, "root");
    this.urls = path.join(this.dir, "urls");
    this.logFile = path.join(this.dir, "log");
    for (const d of [this.bin, this.root, this.urls]) mkdirSync(d, { recursive: true });
    writeFileSync(this.logFile, "");
    this.env = {};
    this.fake("curl", CURL.slice(FAKE_HEAD.length));
    this.fake("sleep", "");
  }

  fake(name, body) {
    const file = path.join(this.bin, name);
    writeFileSync(file, FAKE_HEAD + body + "\n");
    chmodSync(file, 0o755);
  }

  url(url, content) {
    writeFileSync(path.join(this.urls, urlKey(url)), content);
  }

  file(rel, content = "") {
    const file = path.join(this.root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  read(rel) {
    return readFileSync(path.join(this.root, rel), "utf8");
  }

  get log() {
    return readFileSync(this.logFile, "utf8").split("\n").filter(Boolean);
  }

  run(script, args = [], env = {}) {
    const res = spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      stdin: "ignore",
      env: {
        PATH: `${this.bin}:${process.env.PATH}`,
        HOME: this.dir,
        TMPDIR: this.dir,
        FAKE_LOG: this.logFile,
        FAKE_URLS: this.urls,
        LOXAIC_TEST_ROOT: this.root,
        ...this.env,
        ...env,
      },
    });
    return { code: res.status, out: res.stdout + res.stderr };
  }

  destroy() {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** Runs one of the scripts' functions with the script sourced, not executed. */
function call(script, fn, args = [], env = {}) {
  const res = spawnSync("bash", ["-c", `source "$0"; ${fn} "$@"`, script, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, LOXAIC_SOURCE_ONLY: "1", ...env },
  });
  return { code: res.status, out: res.stdout.trimEnd(), err: res.stderr };
}

const sha512 = (content) => createHash("sha512").update(content).digest("base64");
const sha256 = (content) => createHash("sha256").update(content).digest("hex");

// ── install.sh ───────────────────────────────────────────────────────────────

const PRODUCTS = {
  stable: { product: "Loxaic", exe: "loxaic", feed: "latest-linux.yml", prefix: "Loxaic" },
  beta: { product: "Loxaic Beta", exe: "loxaic-beta", feed: "beta-linux.yml", prefix: "Loxaic-Beta" },
};

/** A container with the fakes install.sh needs, as a fresh Ubuntu 24.04 CT. */
function installSandbox() {
  const sb = new Sandbox();
  sb.file("etc/os-release", 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\nVERSION_ID="24.04"\n');
  sb.fake("id", `if [ "$1" = -u ] && [ -n "$2" ]; then grep -qx "$2" "$FAKE_USERS" 2>/dev/null; exit; fi\necho "\${FAKE_UID:-0}"`);
  sb.fake("dpkg", 'echo "${FAKE_ARCH:-amd64}"');
  sb.fake("apt-cache", '[ "$2" = libasound2t64 ] && [ "${FAKE_NO_T64:-}" != 1 ]');
  // Installing a .deb lays down the app as the real package would.
  sb.fake(
    "apt-get",
    `for a in "$@"; do case $a in *.deb)
  d="$LOXAIC_TEST_ROOT/opt/$FAKE_PRODUCT"; mkdir -p "$d/resources/app"
  printf '{\\n  "name": "@loxaic/desktop",\\n  "version": "%s"\\n}\\n' "$FAKE_DEB_VERSION" > "$d/resources/app/package.json"
  : > "$d/$FAKE_EXE" ;;
esac; done`,
  );
  sb.fake("systemctl", '[ "$1" = is-active ] && exit "${FAKE_INACTIVE:-0}"; exit 0');
  sb.fake("docker", 'exit "${FAKE_DOCKER_EXIT:-0}"');
  sb.fake("ldd", 'printf "%s\\n" "${FAKE_LDD:-libc.so.6 => /lib/libc.so.6}"');
  sb.fake("useradd", `echo "\${@: -1}" >> "$FAKE_USERS"`);
  sb.fake("usermod", "");
  sb.fake("getent", '[ "$1" = group ] && case $2 in docker|render|video) echo "$2:x:44:" ;; *) exit 2 ;; esac');
  sb.fake("nvidia-smi", 'echo "${FAKE_NVIDIA_SMI:-}"');
  sb.fake("journalctl", 'echo "last journal lines"');
  sb.fake("hostname", 'echo "192.168.1.50 fd00::50"');
  sb.env.FAKE_USERS = path.join(sb.dir, "users");
  sb.url("http://127.0.0.1:4100/health", JSON.stringify({ status: "ok", services: { database: "ok" } }));
  return sb;
}

/**
 * Publishes a release of `channel` at `version` in the sandbox's fake GitHub:
 * its feed (the real electron-builder shape, from the fixture) and its .deb,
 * whose sha512 the feed carries unless `badSha` is set.
 */
function publish(sb, channel, version, { badSha = false } = {}) {
  const p = PRODUCTS[channel];
  const deb = `${p.prefix}-${version}-linux-amd64.deb`;
  const body = `deb of ${channel} ${version}`;
  const feed = readFileSync(path.join(FIXTURES, p.feed), "utf8")
    .replace(/^version: .*$/m, `version: ${version}`)
    .replace(/url: \S+\.deb\n {4}sha512: \S+/, `url: ${deb}\n    sha512: ${badSha ? sha512("something else") : sha512(body)}`);
  sb.url(`${GH}/releases/download/v${version}/${p.feed}`, feed);
  sb.url(`${GH}/releases/download/v${version}/${deb}`, body);
  return { deb, feed };
}

function useChannel(sb, channel, debVersion) {
  sb.env.FAKE_PRODUCT = PRODUCTS[channel].product;
  sb.env.FAKE_EXE = PRODUCTS[channel].exe;
  sb.env.FAKE_DEB_VERSION = debVersion;
}

const releasesJson = (...releases) =>
  JSON.stringify(
    releases.map(([tag, { draft = false, assets = ["beta-linux.yml"] } = {}]) => ({
      tag_name: tag,
      draft,
      assets: assets.map((name) => ({ name })),
    })),
  );

describe("install.sh: feed and version parsing", () => {
  it("reads the .deb entry, not the AppImage's, from electron-builder's real feed", () => {
    const feed = path.join(FIXTURES, "beta-linux.yml");
    expect(call(INSTALL, "feed_deb_entry", [feed]).out).toBe(
      "Loxaic-Beta-0.0.1-beta.20-linux-amd64.deb 2hSp/1KW7bjkxbSYNdYXmDu5iRLwgnTA8MJ4Y3AXiruznK6e6LtwPnzhWZb5RVpc6M8pfACYB2P41Y2vA1bEAA==",
    );
    expect(call(INSTALL, "feed_version", [feed]).out).toBe("0.0.1-beta.20");
  });

  it("accepts release versions and nothing that could reach a URL or path", () => {
    for (const ok of ["1.2.3", "0.0.1-beta.20"]) expect(call(INSTALL, "valid_version", [ok]).code).toBe(0);
    for (const bad of ["1.2", "v1.2.3", "1.2.3-rc.1", "1.2.3/../x", "1.2.3; rm"]) {
      expect(call(INSTALL, "valid_version", [bad]).code).not.toBe(0);
    }
  });

  it("reads the host's NVIDIA driver version from both kernel module banners", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "nv-"));
    const file = path.join(dir, "version");
    writeFileSync(file, "NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  580.95.05  Release Build  (dvs-builder@U16)\n");
    expect(call(INSTALL, "nvidia_driver_version", [file]).out).toBe("580.95.05");
    writeFileSync(file, "NVRM version: NVIDIA UNIX x86_64 Kernel Module  550.54.14  Thu Feb 22 01:44:30 UTC 2024\n");
    expect(call(INSTALL, "nvidia_driver_version", [file]).out).toBe("550.54.14");
    rmSync(dir, { recursive: true });
  });
});

describe("install.sh", SLOW, () => {
  let sb;
  beforeEach(() => { sb = installSandbox(); });
  afterEach(() => { sb.destroy(); });

  it("installs the newest beta as a headless host under its own user and data directory", () => {
    sb.url(`${API}/releases?per_page=30`, releasesJson(["v0.0.2-beta.1", { draft: true }], ["v0.0.1-beta.20"], ["v0.0.1-beta.19"]));
    const { deb } = publish(sb, "beta", "0.0.1-beta.20");
    useChannel(sb, "beta", "0.0.1-beta.20");

    const { code, out } = sb.run(INSTALL, ["--channel", "beta"]);
    expect(out).toContain("Loxaic Beta 0.0.1-beta.20 is running");
    expect(code).toBe(0);

    const unit = sb.read("etc/systemd/system/loxaic-beta.service");
    expect(unit).toContain("User=loxaic-beta");
    expect(unit).toContain("Environment=ELECTRON_RUN_AS_NODE=1");
    expect(unit).toContain(
      'ExecStart="/opt/Loxaic Beta/loxaic-beta" "/opt/Loxaic Beta/resources/app/src/headless.js" --data-dir=/var/lib/loxaic-beta --port=4100 --as-host --bind lan\n',
    );
    const log = sb.log;
    // A draft is never installed, even when it is the newest.
    expect(log.some((l) => l.includes("v0.0.2-beta.1"))).toBe(false);
    expect(log.some((l) => l.startsWith("apt-get install") && l.endsWith(`/${deb}`))).toBe(true);
    expect(log).toContain("useradd --system --user-group --home-dir /var/lib/loxaic-beta --no-create-home --shell /usr/sbin/nologin loxaic-beta");
    expect(log).toContain("usermod -aG docker loxaic-beta");
    expect(log).toContain("systemctl restart loxaic-beta");
    expect(out).toContain("http://192.168.1.50:4100");
    expect(out).not.toContain("fd00::50");
    expect(out).toContain("the first account made becomes the admin");
  });

  it("installs the stable app from /releases/latest", () => {
    const { feed } = publish(sb, "stable", "1.0.0");
    sb.url(`${GH}/releases/latest/download/latest-linux.yml`, feed);
    useChannel(sb, "stable", "1.0.0");

    const { code, out } = sb.run(INSTALL, []);
    expect(out).toContain("Loxaic 1.0.0 is running");
    expect(code).toBe(0);
    expect(sb.read("etc/systemd/system/loxaic.service")).toContain('ExecStart="/opt/Loxaic/loxaic" ');
    expect(sb.log.some((l) => l.includes("api.github.com"))).toBe(false);
  });

  it("says there is no stable release yet rather than failing on a 404", () => {
    const { code, out } = sb.run(INSTALL, ["--channel", "stable"]);
    expect(code).not.toBe(0);
    expect(out).toContain("Loxaic has no stable release yet. Use --channel beta");
  });

  it("installs a pinned version without asking the API which is newest", () => {
    publish(sb, "beta", "0.0.1-beta.19");
    useChannel(sb, "beta", "0.0.1-beta.19");
    const { code, out } = sb.run(INSTALL, ["--channel", "beta", "--version", "v0.0.1-beta.19"]);
    expect(out).toContain("Loxaic Beta 0.0.1-beta.19 is running");
    expect(code).toBe(0);
    expect(sb.log.some((l) => l.includes("api.github.com"))).toBe(false);
  });

  it("never installs a .deb whose sha512 differs from its feed", () => {
    publish(sb, "beta", "0.0.1-beta.19", { badSha: true });
    useChannel(sb, "beta", "0.0.1-beta.19");
    const { code, out } = sb.run(INSTALL, ["--channel", "beta", "--version", "0.0.1-beta.19"]);
    expect(code).not.toBe(0);
    expect(out).toContain("does not match the sha512 in its release feed");
    expect(sb.log.some((l) => l.startsWith("apt-get install") && l.endsWith(".deb"))).toBe(false);
    expect(existsSync(path.join(sb.root, "etc/systemd/system/loxaic-beta.service"))).toBe(false);
  });

  it("fails, naming them, when the app needs libraries the system lacks", () => {
    publish(sb, "beta", "0.0.1-beta.19");
    useChannel(sb, "beta", "0.0.1-beta.19");
    const { code, out } = sb.run(INSTALL, ["--channel", "beta", "--version", "0.0.1-beta.19"], {
      FAKE_LDD: "libc.so.6 => /lib/libc.so.6\nlibasound.so.2 => not found\nlibgbm.so.1 => not found",
    });
    expect(code).not.toBe(0);
    expect(out).toContain("needs libraries this system lacks: libasound.so.2 libgbm.so.1");
  });

  it("refuses to install one channel beside the other", () => {
    sb.file("etc/systemd/system/loxaic-beta.service", "[Unit]\n");
    const { code, out } = sb.run(INSTALL, ["--channel", "stable"]);
    expect(code).not.toBe(0);
    expect(out).toContain("already runs Loxaic Beta; install Loxaic in a separate container");
    expect(sb.log.some((l) => l.startsWith("apt-get"))).toBe(false);
  });

  it("upgrades the installed channel when run bare, and restarts it", () => {
    publish(sb, "beta", "0.0.1-beta.19");
    useChannel(sb, "beta", "0.0.1-beta.19");
    expect(sb.run(INSTALL, ["--channel", "beta", "--version", "0.0.1-beta.19"]).code).toBe(0);

    sb.url(`${API}/releases?per_page=30`, releasesJson(["v0.0.1-beta.20"], ["v0.0.1-beta.19"]));
    publish(sb, "beta", "0.0.1-beta.20");
    sb.env.FAKE_DEB_VERSION = "0.0.1-beta.20";
    writeFileSync(sb.logFile, "");
    const { code, out } = sb.run(INSTALL, []);
    expect(out).toContain("Loxaic Beta 0.0.1-beta.20 is running");
    expect(code).toBe(0);
    expect(sb.log).toContain("systemctl restart loxaic-beta");
    // An upgrade is not a fresh install: no first-account warning.
    expect(out).not.toContain("first account");
  });

  it("does nothing when the newest release is already installed and running", () => {
    publish(sb, "beta", "0.0.1-beta.19");
    useChannel(sb, "beta", "0.0.1-beta.19");
    expect(sb.run(INSTALL, ["--channel", "beta", "--version", "0.0.1-beta.19"]).code).toBe(0);

    writeFileSync(sb.logFile, "");
    const { code, out } = sb.run(INSTALL, ["--version", "0.0.1-beta.19"]);
    expect(code).toBe(0);
    expect(out).toContain("Already current: Loxaic Beta 0.0.1-beta.19.");
    expect(sb.log.some((l) => l.startsWith("curl") && l.includes(".deb"))).toBe(false);
    expect(sb.log.some((l) => l.startsWith("systemctl restart"))).toBe(false);
  });

  it("starts an installed but stopped service without reinstalling it", () => {
    publish(sb, "beta", "0.0.1-beta.19");
    useChannel(sb, "beta", "0.0.1-beta.19");
    expect(sb.run(INSTALL, ["--channel", "beta", "--version", "0.0.1-beta.19"]).code).toBe(0);
    writeFileSync(sb.logFile, "");
    const { code } = sb.run(INSTALL, ["--version", "0.0.1-beta.19"], { FAKE_INACTIVE: "3" });
    expect(code).toBe(0);
    expect(sb.log).toContain("systemctl start loxaic-beta");
    expect(sb.log.some((l) => l.startsWith("curl") && l.includes(".deb"))).toBe(false);
  });

  it("rewrites the unit and restarts when an option changes", () => {
    publish(sb, "beta", "0.0.1-beta.19");
    useChannel(sb, "beta", "0.0.1-beta.19");
    expect(sb.run(INSTALL, ["--channel", "beta", "--version", "0.0.1-beta.19"]).code).toBe(0);
    writeFileSync(sb.logFile, "");
    const args = ["--version", "0.0.1-beta.19", "--advertise-url", "https://loxaic.example.com", "--host-name", "Rack GPU"];
    expect(sb.run(INSTALL, args).code).toBe(0);
    expect(sb.read("etc/systemd/system/loxaic-beta.service")).toContain(
      ' --as-host --bind lan "--host-name=Rack GPU" --advertise-url=https://loxaic.example.com\n',
    );
    expect(sb.log).toContain("systemctl restart loxaic-beta");
  });

  it("refuses option values systemd would expand", () => {
    for (const args of [["--host-name", "a$HOME"], ["--host-name", "50%"], ["--advertise-url", "https://x.com/path"]]) {
      const { code } = sb.run(INSTALL, args);
      expect(code).not.toBe(0);
    }
    expect(sb.log.some((l) => l.startsWith("apt-get"))).toBe(false);
  });

  it("fails with the journal when the server never becomes healthy", () => {
    rmSync(path.join(sb.urls, urlKey("http://127.0.0.1:4100/health")));
    publish(sb, "beta", "0.0.1-beta.19");
    useChannel(sb, "beta", "0.0.1-beta.19");
    const { code, out } = sb.run(INSTALL, ["--channel", "beta", "--version", "0.0.1-beta.19"], { LOXAIC_HEALTH_TIMEOUT: "0" });
    expect(code).not.toBe(0);
    expect(out).toContain("last journal lines");
    expect(out).toContain("did not become healthy within 0s");
  });

  it("stops before installing when Docker cannot run a container", () => {
    const { code, out } = sb.run(INSTALL, ["--channel", "beta"], { FAKE_DOCKER_EXIT: "125" });
    expect(code).not.toBe(0);
    expect(out).toContain("features nesting=1,keyctl=1");
    expect(sb.log.some((l) => l.includes("api.github.com"))).toBe(false);
  });

  it("refuses non-root, other distributions and other architectures", () => {
    expect(sb.run(INSTALL, [], { FAKE_UID: "1000" }).out).toContain("run this as root");
    expect(sb.run(INSTALL, [], { FAKE_ARCH: "arm64" }).out).toContain("amd64 only");
    sb.file("etc/os-release", "ID=fedora\n");
    expect(sb.run(INSTALL, []).out).toContain("Debian and Ubuntu only");
  });

  it("installs ALSA under its pre-t64 name on releases without the t64 package", () => {
    publish(sb, "beta", "0.0.1-beta.19");
    useChannel(sb, "beta", "0.0.1-beta.19");
    expect(sb.run(INSTALL, ["--channel", "beta", "--version", "0.0.1-beta.19"], { FAKE_NO_T64: "1" }).code).toBe(0);
    const line = sb.log.find((l) => l.startsWith("apt-get install") && l.includes("docker.io"));
    expect(line.split(" ")).toContain("libasound2");
    expect(line).not.toContain("libvulkan1");
  });

  it("adds the Vulkan loader when a GPU is passed through", () => {
    sb.file("dev/dri/renderD128");
    publish(sb, "beta", "0.0.1-beta.19");
    useChannel(sb, "beta", "0.0.1-beta.19");
    expect(sb.run(INSTALL, ["--channel", "beta", "--version", "0.0.1-beta.19"]).code).toBe(0);
    const line = sb.log.find((l) => l.startsWith("apt-get install") && l.includes("docker.io"));
    expect(line).toContain("libvulkan1 mesa-vulkan-drivers");
    expect(sb.log).toContain("usermod -aG render loxaic-beta");
  });

  describe("NVIDIA", () => {
    const V = "580.95.05";
    const RUN_URL = `https://download.nvidia.com/XFree86/Linux-x86_64/${V}/NVIDIA-Linux-x86_64-${V}.run`;
    const RUN = 'printf "%s\\n" "nvidia-installer $*" >> "$FAKE_LOG"\n';
    beforeEach(() => {
      sb.file("dev/nvidiactl");
      sb.file("proc/driver/nvidia/version", `NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  ${V}  Release Build\n`);
      publish(sb, "beta", "0.0.1-beta.19");
      useChannel(sb, "beta", "0.0.1-beta.19");
    });

    it("installs the host driver's user-space half, with no kernel module", () => {
      sb.url(RUN_URL, RUN);
      sb.url(`${RUN_URL}.sha256sum`, `${sha256(RUN)}  NVIDIA-Linux-x86_64-${V}.run\n`);
      expect(sb.run(INSTALL, ["--channel", "beta", "--version", "0.0.1-beta.19"]).code).toBe(0);
      expect(sb.log).toContain("nvidia-installer --silent --no-kernel-modules --no-questions --ui=none");
    });

    it("never runs an installer that differs from NVIDIA's checksum", () => {
      sb.url(RUN_URL, RUN);
      sb.url(`${RUN_URL}.sha256sum`, `${sha256("other")}  NVIDIA-Linux-x86_64-${V}.run\n`);
      const { code, out } = sb.run(INSTALL, ["--channel", "beta", "--version", "0.0.1-beta.19"]);
      expect(code).not.toBe(0);
      expect(out).toContain("does not match NVIDIA's published sha256");
      expect(sb.log.some((l) => l.startsWith("nvidia-installer"))).toBe(false);
    });

    it("skips the driver when the container already has that version", () => {
      const { code } = sb.run(INSTALL, ["--channel", "beta", "--version", "0.0.1-beta.19"], { FAKE_NVIDIA_SMI: V });
      expect(code).toBe(0);
      expect(sb.log.some((l) => l.includes("download.nvidia.com"))).toBe(false);
    });
  });
});

// ── create-lxc.sh ────────────────────────────────────────────────────────────

const TEMPLATES = [
  "system          debian-12-standard_12.7-1_amd64.tar.zst",
  "system          ubuntu-24.04-standard_24.04-2_amd64.tar.zst",
  "system          ubuntu-24.04-standard_24.04-10_amd64.tar.zst",
  "system          ubuntu-22.04-standard_22.04-1_amd64.tar.zst",
].join("\n");

function hostSandbox() {
  const sb = new Sandbox();
  sb.fake("id", 'echo "${FAKE_UID:-0}"');
  sb.fake("uname", 'echo "${FAKE_UNAME:-x86_64}"');
  sb.fake("pveversion", 'echo "${FAKE_PVE:-pve-manager/8.2.4/faa83925c9641325 (running kernel: 6.8.8-2-pve)}"');
  sb.fake("pvesh", "echo 105");
  sb.fake(
    "pvesm",
    `case "$*" in
  *rootdir*) printf 'Name Type Status\\nlocal-lvm lvmthin active\\nfast zfspool active\\n' ;;
  *vztmpl*) printf 'Name Type Status\\nlocal dir active\\n' ;;
esac`,
  );
  sb.fake(
    "pveam",
    `case $1 in
  available) cat "$FAKE_TEMPLATES" ;;
  list) echo "\${FAKE_PVEAM_LIST:-}" ;;
esac`,
  );
  sb.fake(
    "pct",
    `case $1 in
  status) [ -n "\${FAKE_CT_EXISTS:-}" ]; exit ;;
  exec)
    case "$*" in
      *"getent group render"*) echo "render:x:993:" ;;
      *"getent hosts"*) exit "\${FAKE_NO_NET:-0}" ;;
      *loxaic-install*) exit "\${FAKE_INSTALL_EXIT:-0}" ;;
    esac ;;
esac`,
  );
  sb.fake("nvidia-smi", 'exit "${FAKE_NVIDIA_EXIT:-1}"');
  sb.fake("nvidia-modprobe", "");
  sb.env.FAKE_TEMPLATES = path.join(sb.dir, "templates");
  writeFileSync(sb.env.FAKE_TEMPLATES, TEMPLATES + "\n");
  for (const ref of ["master", "beta"]) sb.url(`${RAW}/${ref}/infra/proxmox/install.sh`, `# install.sh from ${ref}\n`);
  return sb;
}

describe("create-lxc.sh: decisions", () => {
  it("needs Proxmox VE 8.1 or newer for device passthrough", () => {
    for (const v of ["pve-manager/8.1.3/x", "pve-manager/8.2.4/x (running kernel: 6.8)", "pve-manager/9.0.3/x"]) {
      expect(call(CREATE, "pve_version_ok", [v]).code).toBe(0);
    }
    for (const v of ["pve-manager/8.0.9/x", "pve-manager/7.4.3/x", "garbage"]) {
      expect(call(CREATE, "pve_version_ok", [v]).code).not.toBe(0);
    }
  });

  it("takes the newest Ubuntu 24.04 template, by version rather than by text", () => {
    const res = spawnSync("bash", ["-c", 'source "$0"; pick_template', CREATE], {
      input: TEMPLATES,
      encoding: "utf8",
      env: { PATH: process.env.PATH, LOXAIC_SOURCE_ONLY: "1" },
    });
    expect(res.stdout.trim()).toBe("ubuntu-24.04-standard_24.04-10_amd64.tar.zst");
  });

  it("fetches each channel's installer from its release branch, never dev", () => {
    expect(call(CREATE, "script_ref", ["stable"]).out).toBe("master");
    expect(call(CREATE, "script_ref", ["beta"]).out).toBe("beta");
    expect(call(CREATE, "script_ref", ["beta"], { LOXAIC_SCRIPT_REF: "feat/x" }).out).toBe("feat/x");
  });

  it("gives DRI nodes the container's render group and NVIDIA nodes an open mode", () => {
    expect(call(CREATE, "device_spec", ["/dev/dri/renderD128", "993"]).out).toBe("/dev/dri/renderD128,gid=993,mode=0660");
    expect(call(CREATE, "device_spec", ["/dev/kfd", "993"]).out).toBe("/dev/kfd,gid=993,mode=0660");
    expect(call(CREATE, "device_spec", ["/dev/nvidia0", ""]).out).toBe("/dev/nvidia0,mode=0666");
  });
});

describe("create-lxc.sh", SLOW, () => {
  let sb;
  beforeEach(() => { sb = hostSandbox(); });
  afterEach(() => { sb.destroy(); });

  const pctCreate = () => sb.log.find((l) => l.startsWith("pct create"));

  it("creates an unprivileged container Docker can run in, then installs the channel from its branch", () => {
    const { code, out } = sb.run(CREATE, ["--channel", "beta", "--version", "0.0.1-beta.19", "--gpu", "none"]);
    expect(out).toContain("Container 105 is ready");
    expect(code).toBe(0);

    const create = pctCreate();
    expect(create).toContain("pct create 105 local:vztmpl/ubuntu-24.04-standard_24.04-10_amd64.tar.zst");
    expect(create).toContain("--unprivileged 1");
    expect(create).toContain("--features nesting=1,keyctl=1");
    expect(create).toContain("--rootfs local-lvm:64");
    expect(create).toContain("--net0 name=eth0,bridge=vmbr0,ip=dhcp");
    expect(create).toContain("--onboot 1");
    const log = sb.log;
    expect(log).toContain("pveam download local ubuntu-24.04-standard_24.04-10_amd64.tar.zst");
    expect(log.some((l) => l.startsWith("curl") && l.includes(`${RAW}/beta/infra/proxmox/install.sh`))).toBe(true);
    expect(log.some((l) => /^pct push 105 \S+ \/usr\/local\/sbin\/loxaic-install --perms 0755$/.test(l))).toBe(true);
    expect(log).toContain("pct exec 105 -- /usr/local/sbin/loxaic-install --channel beta --version 0.0.1-beta.19");
    // --gpu none: no passthrough, so no stop-and-restart either.
    expect(log.some((l) => l.startsWith("pct set") || l.startsWith("pct stop"))).toBe(false);
  });

  it("installs stable from master, and reuses a template that is already downloaded", () => {
    const { code } = sb.run(CREATE, ["--gpu", "none"], { FAKE_PVEAM_LIST: "local:vztmpl/ubuntu-24.04-standard_24.04-10_amd64.tar.zst" });
    expect(code).toBe(0);
    expect(sb.log.some((l) => l.startsWith("curl") && l.includes(`${RAW}/master/infra/proxmox/install.sh`))).toBe(true);
    expect(sb.log).toContain("pct exec 105 -- /usr/local/sbin/loxaic-install --channel stable");
    expect(sb.log.some((l) => l.startsWith("pveam download"))).toBe(false);
  });

  it("passes AMD/Intel render nodes and /dev/kfd through with the container's render gid", () => {
    sb.file("dev/dri/renderD128");
    sb.file("dev/dri/card0");
    sb.file("dev/kfd");
    expect(sb.run(CREATE, []).code).toBe(0);
    const log = sb.log;
    expect(log).toContain("pct set 105 --dev0 /dev/dri/renderD128,gid=993,mode=0660");
    expect(log).toContain("pct set 105 --dev1 /dev/kfd,gid=993,mode=0660");
    expect(log.some((l) => l.includes("card0"))).toBe(false);
    // The devices are set on a stopped container, and it is started again.
    const stop = log.indexOf("pct stop 105");
    expect(stop).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(log.indexOf("pct set 105 --dev0 /dev/dri/renderD128,gid=993,mode=0660"));
    expect(log.lastIndexOf("pct start 105")).toBeGreaterThan(stop);
  });

  it("passes every NVIDIA node through when the host driver works", () => {
    for (const d of ["nvidia0", "nvidiactl", "nvidia-uvm", "nvidia-uvm-tools", "nvidia-caps/nvidia-cap1"]) sb.file(`dev/${d}`);
    const { code, out } = sb.run(CREATE, ["--gpu", "nvidia"], { FAKE_NVIDIA_EXIT: "0" });
    expect(code).toBe(0);
    const sets = sb.log.filter((l) => l.startsWith("pct set"));
    expect(sets).toEqual([
      "pct set 105 --dev0 /dev/nvidia0,mode=0666",
      "pct set 105 --dev1 /dev/nvidiactl,mode=0666",
      "pct set 105 --dev2 /dev/nvidia-uvm,mode=0666",
      "pct set 105 --dev3 /dev/nvidia-uvm-tools,mode=0666",
      "pct set 105 --dev4 /dev/nvidia-caps/nvidia-cap1,mode=0666",
    ]);
    expect(out).toContain("/dev/nvidia-uvm exists");
  });

  it("creates the UVM node first when the host has not used CUDA since boot", () => {
    sb.file("dev/nvidia0");
    sb.file("dev/nvidiactl");
    expect(sb.run(CREATE, ["--gpu", "nvidia"], { FAKE_NVIDIA_EXIT: "0" }).code).toBe(0);
    expect(sb.log).toContain("nvidia-modprobe -u -c=0");
  });

  it("refuses a GPU it was asked for and cannot find", () => {
    expect(sb.run(CREATE, ["--gpu", "nvidia"]).out).toContain("needs a working NVIDIA driver on this host");
    expect(sb.run(CREATE, ["--gpu", "dri"]).out).toContain("no /dev/dri/renderD* device");
    expect(pctCreate()).toBeUndefined();
  });

  it("with --gpu auto and no GPU, creates a container without passthrough", () => {
    expect(sb.run(CREATE, []).code).toBe(0);
    expect(sb.log.some((l) => l.startsWith("pct set"))).toBe(false);
  });

  it("refuses before touching anything when the host or the options are wrong", () => {
    const cases = [
      [[], { FAKE_UID: "1000" }, "run this as root"],
      [[], { FAKE_PVE: "pve-manager/8.0.9/abc (running kernel: 6.2)" }, "Proxmox VE 8.1 or newer"],
      [[], { FAKE_UNAME: "aarch64" }, "x86_64 only"],
      [["--channel", "dev"], {}, "--channel must be stable or beta"],
      [["--storage", "nope"], {}, "storage 'nope' cannot hold containers here; choose one of: local-lvm fast"],
      [[], { FAKE_CT_EXISTS: "1" }, "container 105 already exists"],
      [["--ip", "192.168.1.50/24"], {}, "a static --ip needs --gateway"],
      [["--hostname", "bad name"], {}, "--hostname may contain only"],
    ];
    for (const [args, env, message] of cases) {
      const { code, out } = sb.run(CREATE, args, env);
      expect(code, message).not.toBe(0);
      expect(out).toContain(message);
    }
    expect(pctCreate()).toBeUndefined();
  });

  it("sets a static address with its gateway", () => {
    expect(sb.run(CREATE, ["--gpu", "none", "--ip", "192.168.1.50/24", "--gateway", "192.168.1.1"]).code).toBe(0);
    expect(pctCreate()).toContain("--net0 name=eth0,bridge=vmbr0,ip=192.168.1.50/24,gw=192.168.1.1");
  });

  it("gives up on a container whose network never comes up", () => {
    const { code, out } = sb.run(CREATE, ["--gpu", "none"], { FAKE_NO_NET: "2", LOXAIC_NETWORK_TIMEOUT: "0" });
    expect(code).not.toBe(0);
    expect(out).toContain("cannot resolve github.com");
  });

  it("says how to retry or remove the container when the install inside it fails", () => {
    const { code, out } = sb.run(CREATE, ["--gpu", "none"], { FAKE_INSTALL_EXIT: "1" });
    expect(code).not.toBe(0);
    expect(out).toContain("pct exec 105 -- loxaic-install, or remove it with: pct destroy 105");
  });

  it("pushes a local installer instead of downloading one when told to", () => {
    const local = path.join(sb.dir, "install.sh");
    writeFileSync(local, "# local\n");
    expect(sb.run(CREATE, ["--gpu", "none"], { LOXAIC_INSTALL_SCRIPT: local }).code).toBe(0);
    expect(sb.log).toContain(`pct push 105 ${local} /usr/local/sbin/loxaic-install --perms 0755`);
    expect(sb.log.some((l) => l.startsWith("curl"))).toBe(false);
  });
});
