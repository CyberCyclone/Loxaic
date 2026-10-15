/**
 * The Chromium command line, as a pure function (#281).
 *
 * Split out from `container.ts` because these flags *are* the security
 * boundary around what a page can make the browser reach, and a unit test can
 * check each one far more cheaply than a container can. The three that carry
 * that weight are named at their lines: the forced proxy, the dead resolver,
 * and the tmpfs profile.
 */

/** Where the profile lives: a tmpfs, so it is gone when the container is. */
export const BROWSER_PROFILE_DIR = "/home/loxaic/profile";
/** The port Chromium publishes CDP on, inside the session's own network. Never
 * published to the host — see container.ts. */
export const CDP_PORT = 9222;

export interface LaunchInputs {
  /** The server's browser proxy, as an `http://ip:port` URL. An IP address on
   * purpose: this container resolves nothing (see `--host-resolver-rules`), so
   * a hostname would have to be resolved *somewhere* else and whatever answered
   * later would be a second, unchecked decision about where the browser may go. */
  proxyUrl: string;
  /** Constrain every page to this viewport; screenshots are taken at it. */
  viewport?: { width: number; height: number };
  /** Chromium's own seccomp sandbox. Only ever true for a diagnostic run:
   * under `CapDrop: ALL` + `no-new-privileges` (the container flags, which are
   * not negotiable) the SUID sandbox helper cannot do what it does, so
   * `container.ts` always passes false. See the note there for why that is not
   * the hole it looks like. */
  chromiumSandbox?: boolean;
  consoleLog?: (message: string) => void;
}

/**
 * The flag list for one browser session.
 *
 * Order matters only in that Chromium honours the last of a repeated flag;
 * nothing here repeats one.
 */
export function chromiumArgs(inputs: LaunchInputs): string[] {
  const viewport = inputs.viewport ?? { width: 1280, height: 720 };
  const args = [
    "--headless=new",
    `--user-data-dir=${BROWSER_PROFILE_DIR}`,
    // Reachable from inside the session's network only. CDP is the full control
    // surface of a browser, so the two things that keep it private are the
    // per-session network (container.ts) and the absence of any published port;
    // the address it binds is not the control, since the network has no other
    // member that is not the server's own proxy.
    `--remote-debugging-port=${String(CDP_PORT)}`,
    "--remote-debugging-address=0.0.0.0",
    // Every request, including ones a page makes to localhost, goes to the
    // proxy. Without `<-loopback>` Chromium applies its built-in "localhost is
    // never proxied" rule, and a page navigating to http://127.0.0.1:4000 would
    // reach the server without ever meeting the SSRF guard — the single easiest
    // way this feature could leak the host, which is why it is a bypass *list*
    // naming nothing rather than an absent proxy setting.
    `--proxy-server=${inputs.proxyUrl}`,
    '--proxy-bypass-list="<-loopback>"',
    // No DNS in this container at all. Resolving here would put a second,
    // unguarded answer between the proxy's check and the connection (and a
    // TOCTOU DNS-rebinding answer between the check and the *next* request): the
    // proxy is the only thing in this design that resolves a name, so it is the
    // only thing that decides where a byte may go.
    '--host-resolver-rules=MAP * ~NOTFOUND',
    // /dev/shm inside a container is 64 MB by default and Chromium crashes a
    // tab (render-process-gone, which surfaces as an opaque tool error) well
    // before that on an ordinary page.
    "--disable-dev-shm-usage",
    // Nothing in here should phone home on its own. Each of these is a request
    // the *browser* makes for its own reasons, which would otherwise go through
    // the proxy and count against the session, and would be a channel that no
    // user asked for.
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-feature=InterestFeedContentSuggestions",
    // Casting and route discovery are multicast/broadcast traffic, which the
    // proxy cannot police because it is not proxied at all.
    "--disable-features=MediaRouter,DialMediaRouteProvider",
    "--no-first-run",
    "--no-default-browser-check",
    `--window-size=${String(viewport.width)},${String(viewport.height)}`,
    "--hide-scrollbars",
    // Screenshots of pages that never finish loading are the common case on a
    // busy site; leaving the font antialiasing alone keeps them legible.
    "--force-color-profile=srgb",
  ];
  if (!inputs.chromiumSandbox) args.push("--no-sandbox");
  inputs.consoleLog?.(`chromium ${args.join(" ")}`);
  return args;
}

/** The environment Chromium is launched with. Deliberately nothing: an extra
 * variable here is one more thing that can carry a credential into a process
 * rendering hostile pages, and one more thing that could change where it sends
 * bytes. Notably absent is any `http_proxy`/`NO_PROXY` pair — the proxy is set
 * by flag, and an env pair alongside it is a second, conflicting answer. */
export function chromiumEnv(): Record<string, string> {
  return {
    HOME: "/home/loxaic",
  };
}
