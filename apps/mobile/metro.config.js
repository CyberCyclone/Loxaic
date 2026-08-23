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

// Force singletons on WEB only: other workspace packages pin different React
// versions, and a dependency resolving the workspace-root copy would put two
// Reacts in one web bundle ("Cannot read properties of null (reading
// 'useState')"). Native must stay hands-off — redirecting react-native/*
// there breaks Expo's dev-runtime shims (e.g. getDevServer).
const SINGLETONS = ['react', 'react-dom', 'react-native', 'react-native-web'];
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const singleton =
    platform === 'web' &&
    SINGLETONS.find(
      (name) => moduleName === name || moduleName.startsWith(`${name}/`),
    );
  if (singleton) {
    // Re-resolve as if imported from the app root, so the app's own copy wins.
    return context.resolveRequest(
      { ...context, originModulePath: path.join(projectRoot, 'index.js') },
      moduleName,
      platform,
    );
  }
  return (defaultResolveRequest || context.resolveRequest)(
    context,
    moduleName,
    platform,
  );
};

// withUniwindConfig must be the outermost wrapper.
module.exports = withUniwindConfig(config, {
  cssEntryFile: './global.css',
  dtsFile: './uniwind-types.d.ts',
  extraThemes: ['dark'],
});
