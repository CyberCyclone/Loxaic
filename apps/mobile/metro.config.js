const { getDefaultConfig } = require('expo/metro-config');
const { withUniwindConfig } = require('uniwind/metro');
const path = require('path');
const { OUT_FILE, writeChangelog } = require('./scripts/changelog.cjs');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// pnpm monorepo: watch the workspace and resolve from both node_modules roots.
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// No custom resolveRequest here, deliberately. A React-singleton shim used to
// live in this file because @legendapp/motion's required `nativewind` peer made
// pnpm materialise a second React; that dependency is gone (overlays animate
// with react-native-reanimated now). If "Invalid hook call" ever comes back,
// find the dependency that dragged in a second `react` rather than re-adding
// the shim — see the root AGENTS.md.

// The changelog Settings shows, from git history, written before anything is
// bundled: every bundle (web export, OTA update, Electron's build:web, a dev
// session) goes through this file, and lib/changelog.ts requires the result.
// History that cannot be read leaves the bundle without a changelog, never
// stops it. Only a file that cannot be written throws, and it is reported and
// left as it was: a kept file still bundles, and with none at all Metro's
// error names the file.
try {
  writeChangelog();
} catch (err) {
  console.warn(`[changelog] could not write ${OUT_FILE}: ${err instanceof Error ? err.message : String(err)}`);
}

// withUniwindConfig must be the outermost wrapper.
module.exports = withUniwindConfig(config, {
  cssEntryFile: './global.css',
  dtsFile: './uniwind-types.d.ts',
  extraThemes: ['dark'],
});
