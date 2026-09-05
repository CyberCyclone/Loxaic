const { getDefaultConfig } = require('expo/metro-config');
const { withUniwindConfig } = require('uniwind/metro');
const path = require('path');

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
// the shim — see AGENTS.md.

// withUniwindConfig must be the outermost wrapper.
module.exports = withUniwindConfig(config, {
  cssEntryFile: './global.css',
  dtsFile: './uniwind-types.d.ts',
  extraThemes: ['dark'],
});
