/**
 * The browser driver: the only file in the server that touches Playwright
 * (#281).
 *
 * **Why the types are hand-narrowed.** `playwright-core/types/types.d.ts` is
 * 1.1 MB, plus 0.8 MB of Chrome DevTools protocol types. Importing it into the
 * server's program pushes `tsc --noEmit` past its memory ceiling (it OOMs in a
 * 512 MB cgroup, which is a deployment shape this project supports, not a
 * curiosity). The same narrowing the sandbox layer already uses for dockerode
 * (`DemuxCapableModem` in sandbox/container-engine.ts) applies here: declare the
 * handful of members actually used, and keep the library out of the type graph.
 *
 * The import below goes through a **variable specifier** so TypeScript does not
 * resolve it statically — that is the whole trick, and it is why this file is
 * the only place allowed to import the package. `playwright-core` stays a
 * normal dependency, so the bundler keeps it external and runtime resolution is
 * unchanged.
 *
 * The narrower interface is also the seam the tool actions are tested against
 * (`__tests__/browse-actions.test.ts` drives a stub), which a direct dependency
 * on Playwright's `Page` would not be.
 */

/** The members of `playwright-core` this file uses, by hand. */
interface ChromiumLauncher {
  connectOverCDP(
    endpointURL: string,
    options: { timeout: number },
  ): Promise<PlaywrightBrowser>;
}

interface PlaywrightBrowser {
  isConnected(): boolean;
  contexts(): PlaywrightContext[];
  newContext(): Promise<PlaywrightContext>;
  close(): Promise<void>;
}

interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>;
  /** `deny` means a page cannot put bytes anywhere: a download would land in the
   * container's tmpfs where nothing can read it back, so "it downloaded
   * something" would be a claim no tool can substantiate. `downloadsPath` is
   * required by the API even to say deny; nothing is created at it. */
  setDownloadBehavior(options: { behavior: "allow" | "deny"; downloadsPath: string }): Promise<void>;
}

interface PlaywrightPage {
  goto(url: string, options?: { timeout?: number }): Promise<{ status(): number | null } | null>;
  goBack(options?: { timeout?: number }): Promise<unknown>;
  goForward(options?: { timeout?: number }): Promise<unknown>;
  reload(options?: { timeout?: number }): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  content(): Promise<string>;
  screenshot(options: { fullPage: boolean; type: "png" | "jpeg"; timeout?: number }): Promise<Buffer>;
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  fill(selector: string, value: string, options?: { timeout?: number }): Promise<void>;
  press(selector: string, key: string, options?: { timeout?: number }): Promise<void>;
  selectOption(selector: string, value: string): Promise<unknown>;
  hover(selector: string, options?: { timeout?: number }): Promise<void>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  waitForLoadState(state: "load" | "domcontentloaded" | "networkidle", options?: { timeout?: number }): Promise<void>;
  /** Playwright serialises the function into the page, so the types either side
   * are only ours to declare. The arg-taking overload is written with a named
   * `A` rather than `unknown` in the parameter position, because a function
   * declared `(delta: number) => void` is not assignable to a parameter type of
   * `unknown` (contravariance) and would need a cast at every call site. */
  evaluate(pageFunction: () => unknown): Promise<unknown>;
  evaluate<A>(pageFunction: (arg: A) => unknown, arg: A): Promise<unknown>;
  close(): Promise<void>;
}

/** The specifier is returned from a function so its type is `string` rather
 * than a string literal. That distinction is the whole trick: TypeScript
 * resolves a dynamic `import()` whose specifier has a literal type, and pulling
 * this package's types into the program is what the narrowing above exists to
 * avoid. `playwright-core` is a normal dependency, so the bundler keeps it
 * external and runtime resolution is unchanged.
 *
 * If a future change makes this file's types stop resolving at runtime (a
 * bundler that inlines it, a rename), the browse tool fails at its first call
 * with a module-not-found error; the e2e browsing spec is what catches that. */
function playwrightModule(): string {
  return "playwright-core";
}

/** `connectOverCDP`, without the type. */
async function launcher(): Promise<ChromiumLauncher> {
  const specifier = playwrightModule();
  const module = (await import(specifier)) as { chromium: ChromiumLauncher };
  return module.chromium;
}

/** One method of a page, resolved by name through the narrowed interface.
 * Exported so `actions.ts` can call it without naming Playwright's types, and
 * so a stub driver can satisfy the same shape in tests. */
export interface PageDriver {
  goto(url: string): Promise<{ status: number | null }>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  url(): string;
  title(): Promise<string>;
  content(): Promise<string>;
  screenshot(fullPage: boolean, type: "png" | "jpeg"): Promise<Buffer>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  press(selector: string, key: string): Promise<void>;
  selectOption(selector: string, value: string): Promise<void>;
  hover(selector: string): Promise<void>;
  waitForSelector(selector: string): Promise<void>;
  waitForLoadState(state: "load" | "domcontentloaded" | "networkidle"): Promise<void>;
  /** The page's links, in DOM order, as href + text. Run in the page so the
   * browser's own resolution of relative hrefs is what we report. */
  links(): Promise<{ text: string; href: string }[]>;
  /** The rendered text — what the user would read, after script and CSS. */
  renderedText(): Promise<string>;
  scrollBy(pixels: number): Promise<void>;
}

/** A live connection to one session's Chromium. */
export interface BrowserConnection {
  /** The page the actions run against: one per session, so navigation state
   * survives between tool calls and between turns. */
  page: PageDriver;
  isConnected(): boolean;
  close(): Promise<void>;
}

/**
 * Connects to a session's Chromium over CDP.
 *
 * `timeoutMs` bounds the connection attempt only; every action carries its own
 * timeout (`actionTimeoutMs`), applied here rather than on the context, so the
 * number a caller passes is the number that governs the call it belongs to.
 */
export async function connectBrowser(cdpUrl: string, timeoutMs: number, actionTimeoutMs: number): Promise<BrowserConnection> {
  const chromium = await launcher();
  const browser = await chromium.connectOverCDP(cdpUrl, { timeout: timeoutMs });
  const context = browser.contexts()[0] ?? (await browser.newContext());
  try {
    await context.setDownloadBehavior({ behavior: "deny", downloadsPath: DOWNLOAD_PATH });
  } catch {
    // A browser that will not accept the setting (an older CDP target) must not
    // make the session unusable; a download would then land in the tmpfs, where
    // it dies with the container and nothing can read it back either way.
  }
  const raw = await context.newPage();
  return {
    isConnected: () => browser.isConnected(),
    close: async () => {
      await browser.close();
    },
    page: wrapPage(raw, actionTimeoutMs),
  };
}

/** Where downloads *would* go, named only because the CDP call requires a path
 * to deny them. On the tmpfs profile, so it exists nowhere after a destroy. */
const DOWNLOAD_PATH = "/home/loxaic/downloads";

/** The DOM members the two injected functions touch, declared locally so the
 * server's program needs no DOM lib (it is a Node program) and so this file
 * remains the only one that knows anything about the page side. The shapes are
 * what the functions below actually use — nothing here is a general DOM type. */
declare const document: {
  readonly body: { readonly innerText?: string; readonly textContent?: string } | null;
  querySelectorAll(selector: string): { readonly length: number; item(index: number): { readonly textContent: string | null; readonly href: string } | null };
};
declare const window: { scrollBy(x: number, y: number): void };

/** The page's links, evaluated in the page. Relative hrefs come back resolved
 * by the browser, which is the only correct answer for them. Capped: a page with
 * ten thousand anchors is a directory listing or a crawler trap, and the model
 * cannot use the rest. */
const LINKS_FUNCTION = (): { text: string; href: string }[] => {
  const found = document.querySelectorAll("a[href]");
  const out: { text: string; href: string }[] = [];
  const limit = Math.min(found.length, 300);
  for (let i = 0; i < limit; i++) {
    const anchor = found.item(i);
    if (!anchor) continue;
    out.push({ text: (anchor.textContent ?? "").trim().slice(0, 200), href: anchor.href });
  }
  return out;
};

/** The rendered body text. `innerText` rather than `textContent`: it respects
 * what is actually displayed (hidden elements excluded), which is the thing a
 * screenshot would show and the thing the model is being asked about. */
const RENDERED_TEXT_FUNCTION = (): string => {
  const body = document.body;
  if (!body) return "";
  const text = body.innerText ?? body.textContent ?? "";
  return text.replace(/\n{3,}/g, "\n\n").trim();
};

const SCROLL_FUNCTION = (delta: number): void => window.scrollBy(0, delta);

function wrapPage(page: PlaywrightPage, actionTimeoutMs: number): PageDriver {
  return {
    async goto(url) {
      const response = await page.goto(url, { timeout: actionTimeoutMs });
      return { status: response?.status() ?? null };
    },
    async goBack() {
      await page.goBack({ timeout: actionTimeoutMs });
    },
    async goForward() {
      await page.goForward({ timeout: actionTimeoutMs });
    },
    async reload() {
      await page.reload({ timeout: actionTimeoutMs });
    },
    url: () => page.url(),
    title: () => page.title(),
    content: () => page.content(),
    screenshot: (fullPage, type) => page.screenshot({ fullPage, type, timeout: actionTimeoutMs }),
    click: (selector) => page.click(selector, { timeout: actionTimeoutMs }),
    fill: (selector, value) => page.fill(selector, value, { timeout: actionTimeoutMs }),
    press: (selector, key) => page.press(selector, key, { timeout: actionTimeoutMs }),
    async selectOption(selector, value) {
      await page.selectOption(selector, value);
    },
    hover: (selector) => page.hover(selector, { timeout: actionTimeoutMs }),
    async waitForSelector(selector) {
      await page.waitForSelector(selector, { timeout: actionTimeoutMs });
    },
    waitForLoadState: (state) => page.waitForLoadState(state, { timeout: actionTimeoutMs }),
    async links() {
      return (await page.evaluate(LINKS_FUNCTION)) as { text: string; href: string }[];
    },
    async renderedText() {
      return (await page.evaluate(RENDERED_TEXT_FUNCTION)) as string;
    },
    async scrollBy(pixels) {
      // Done in the page rather than through an input event so it works on a
      // page whose layout has no scrollable viewport of its own; a site's own
      // scroll handlers still fire, which is what lazy-loaded content needs.
      await page.evaluate(SCROLL_FUNCTION, pixels);
    },
  };
}
