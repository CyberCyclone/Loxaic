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
    probeHost: (url) => ipcRenderer.invoke("loxaic:probeHost", url),
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
});
