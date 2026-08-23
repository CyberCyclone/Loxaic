// Runs in the renderer's isolated world (contextIsolation: true). Exposes
// only a plain-data bridge — no Node/Electron APIs reach the page itself.
// CommonJS (.cjs) rather than the package's default ESM: Electron loads
// preload scripts in a context that does not support `import` regardless of
// the surrounding package.json's "type", and .cjs is the one extension Node
// always treats as CommonJS no matter what "type" says.
//
// `apiBaseUrl` is resolved by the main process (see main.js) before the
// window is created and handed in via webPreferences.additionalArguments,
// since the renderer is a static web build with no server at the app://
// origin it loads from — it has no other way to learn where the real API is.
const { contextBridge } = require("electron");

function readArg(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? decodeURIComponent(arg.slice(prefix.length)) : null;
}

contextBridge.exposeInMainWorld("shannon", {
  platform: "electron",
  apiBaseUrl: readArg("shannon-api-base-url"),
});
