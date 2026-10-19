/**
 * The slice of playwright-core the browser fallback uses, typed by hand.
 *
 * playwright-core's own declarations are ~1.9 MB; pulling them into the
 * server's program is what pushed `tsc` past a 512 MB container's memory in
 * #305's first version. manager.ts is the only file that imports the library,
 * and it casts the module to `ChromiumLike`. These interfaces are also the seam
 * the manager and interception tests use, so a fake browser satisfies them.
 */

export interface RequestLike {
  url(): string;
  method(): string;
  allHeaders(): Promise<Record<string, string>>;
  postDataBuffer(): Buffer | null;
  isNavigationRequest(): boolean;
  frame(): FrameLike;
}

export interface FrameLike {
  page(): PageLike;
}

export interface RouteLike {
  request(): RequestLike;
  abort(errorCode?: string): Promise<void>;
  fulfill(response: { status: number; headers: Record<string, string>; body: Buffer }): Promise<void>;
}

export interface WebSocketRouteLike {
  close(): void;
}

export interface ResponseLike {
  status(): number;
}

export interface PageLike {
  goto(url: string, options: { waitUntil: "domcontentloaded" | "load"; timeout: number }): Promise<ResponseLike | null>;
  waitForLoadState(state: "networkidle", options: { timeout: number }): Promise<void>;
  /** An expression, evaluated in the page; see render.ts for why not a function. */
  evaluate<R>(expression: string): Promise<R>;
  screenshot(options: { type: "png"; fullPage: boolean; timeout: number; clip?: { x: number; y: number; width: number; height: number } }): Promise<Buffer>;
  title(): Promise<string>;
  url(): string;
  mainFrame(): FrameLike;
  close(options?: { runBeforeUnload?: boolean }): Promise<void>;
  waitForURL(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<void>;
  /** A window this page opened (window.open, target=_blank). */
  on(event: "popup", listener: (popup: PageLike) => void): void;
}

/** A raw DevTools session, for what Playwright does not expose: reading a page
 * from an isolated world its own scripts cannot reach (render.ts). */
export interface CDPSessionLike {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  detach(): Promise<void>;
}

export interface BrowserContextLike {
  newPage(): Promise<PageLike>;
  newCDPSession(page: PageLike): Promise<CDPSessionLike>;
  /** Source run in every frame before the page's own scripts. */
  addInitScript(script: { content: string }): Promise<void>;
  /** Every page opened in the context, popups included. */
  on(event: "page", listener: (page: PageLike) => void): void;
  route(pattern: string, handler: (route: RouteLike) => Promise<void>): Promise<void>;
  routeWebSocket(pattern: string, handler: (ws: WebSocketRouteLike) => void): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserLike {
  newContext(options: {
    serviceWorkers: "block";
    acceptDownloads: false;
    viewport: { width: number; height: number };
    userAgent?: string;
    javaScriptEnabled: true;
  }): Promise<BrowserContextLike>;
  version(): string;
  close(): Promise<void>;
  on(event: "disconnected", listener: () => void): void;
}

export interface LaunchOptions {
  executablePath: string;
  headless: true;
  chromiumSandbox: boolean;
  args: string[];
  timeout: number;
}

export interface ChromiumLike {
  launch(options: LaunchOptions): Promise<BrowserLike>;
}
