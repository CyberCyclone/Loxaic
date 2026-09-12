// Runs in the renderer's isolated world (contextIsolation: true). Exposes
// only a plain-data bridge plus a fixed set of main-process calls — no
// Node/Electron APIs reach the page itself.
// CommonJS (.cjs) rather than the package's default ESM: Electron loads
// preload scripts in a context that does not support `import` regardless of
// the surrounding package.json's "type", and .cjs is the one extension Node
// always treats as CommonJS no matter what "type" says.
//
// `apiBaseUrl` is resolved by the main process (see main.js) before the
// window is created and handed in via webPreferences.additionalArguments,
// since the renderer is a static web build with no server at the app://
// origin it loads from — it has no other way to learn where the real API is.
// It is empty when the app opens on onboarding: there is no server yet, and
// the real URL arrives over `onStackState` once a mode is chosen.
const { contextBridge, ipcRenderer } = require("electron");

function readArg(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? decodeURIComponent(arg.slice(prefix.length)) : null;
}

const launchApiBaseUrl = readArg("loxaic-api-base-url") || null;

contextBridge.exposeInMainWorld("loxaic", {
  platform: "electron",
  apiBaseUrl: launchApiBaseUrl,

  /**
   * Instance-mode control. Every method is a fixed channel with no path,
   * command, or file argument — the renderer asks the main process to do one
   * of a handful of named things, and cannot ask it to do anything else.
   */
  instance: {
    getState: () => ipcRenderer.invoke("loxaic:getState"),
    setMode: (config) => ipcRenderer.invoke("loxaic:setMode", config),
    probeEngine: () => ipcRenderer.invoke("loxaic:probeEngine"),
    /** `opts.via === "tsnet"` reaches the host through the embedded
     * Tailscale sidecar, joining the tailnet first if this machine has not. */
    probeHost: (url, opts) => ipcRenderer.invoke("loxaic:probeHost", url, opts),
    testDb: (input) => ipcRenderer.invoke("loxaic:testDb", input),
    detach: () => ipcRenderer.invoke("loxaic:detach"),

    /**
     * Fires whenever the stack changes — a mode switch, a detach, or the
     * initial resolve completing after the window opened. Returns an
     * unsubscribe function; the listener is wrapped so the renderer never
     * receives Electron's IpcRendererEvent (which carries `sender`, i.e. a
     * live handle back into the main process).
     */
    onStackState: (callback) => {
      const listener = (_event, state) => { callback(state); };
      ipcRenderer.on("loxaic:stackState", listener);
      return () => { ipcRenderer.off("loxaic:stackState", listener); };
    },
  },

  /**
   * The embedded Tailscale sidecar. Its settings are written through
   * `instance.setMode` like everything else in config.json; these are the
   * live state and two actions. `openAuthUrl` takes no URL — the main process
   * opens the one the sidecar printed and nothing else, so a page cannot ask
   * it to open an arbitrary address in the person's browser.
   */
  tailnet: {
    getState: () => ipcRenderer.invoke("loxaic:tailnet.getState"),
    openAuthUrl: () => ipcRenderer.invoke("loxaic:tailnet.openAuthUrl"),
    restart: () => ipcRenderer.invoke("loxaic:tailnet.restart"),
  },

  /**
   * The local executor: this machine running agent commands in a folder the
   * user chose. Same rule as `instance`: fixed channels, and the one that
   * involves a path (`pickDirectory`) takes none from the renderer — the
   * main process opens the *native* folder dialog and records what the user
   * picked there. `removeRoot` only accepts a path that is already a root,
   * so it can only ever narrow the list.
   */
  executor: {
    /** Hand the executor the signed-in session (null on sign-out). The token
     * goes main-process → executor stdin and is never persisted. */
    setSession: (token) => ipcRenderer.invoke("loxaic:executor.setSession", token),
    getState: () => ipcRenderer.invoke("loxaic:executor.getState"),
    pickDirectory: () => ipcRenderer.invoke("loxaic:pickDirectory"),
    removeRoot: (dir) => ipcRenderer.invoke("loxaic:executor.removeRoot", dir),
    onState: (callback) => {
      const listener = (_event, state) => { callback(state); };
      ipcRenderer.on("loxaic:executorState", listener);
      return () => { ipcRenderer.off("loxaic:executorState", listener); };
    },
  },
});
