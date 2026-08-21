import { app, BrowserWindow } from "electron";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

function getDistPath() {
  if (isDev) return "../../apps/web/dist";
  return path.join(process.resourcesPath, "web");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#18181b",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    mainWindow.loadFile(path.join(getDistPath(), "index.html"));
  }

  // Optional: spawn local llama.cpp sidecar
  const llmPath = process.env.LLAMA_CPP_PATH;
  if (llmPath) {
    const modelPath = process.env.LLAMA_MODEL;
    if (modelPath) {
      spawn(llmPath, [
        "--host", "127.0.0.1", "--port", "8082",
        "-m", modelPath, "--ctx-size", "4096",
      ], { stdio: "ignore" });
    }
  }

  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (!mainWindow) createWindow(); });