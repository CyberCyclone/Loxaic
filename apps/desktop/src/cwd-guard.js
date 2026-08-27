// Must be main.js's FIRST import (imports execute in order, before any of
// main.js's own statements). A packaged app doesn't control the cwd it's
// launched with: chromedriver hands it its own cwd — which macOS TCC can make
// unreadable for the app bundle (EPERM on uv_cwd for e.g. ~/Documents), and
// Finder launches use "/". Any module-load process.cwd() then throws an
// uncaught exception and Electron dies in a blocking error dialog. Heal it
// before other modules load.
try {
  process.cwd();
} catch {
  process.chdir("/");
}
