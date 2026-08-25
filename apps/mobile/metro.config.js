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

// `react` (and its jsx-runtime entry points) must be a singleton on EVERY
// platform, not just web: @legendapp/motion (used by the vendored gluestack
// Actionsheet/Select) has a *required* peer on `nativewind`, which pnpm can
// only satisfy by resolving a whole separate react-native@0.76/react@19.2.8
// island (this app is on react-native 0.81.5/react 19.1.0 — nativewind
// itself is never actually used, UniWind is the real styling engine, but
// pnpm still has to satisfy the declared peer). Without forcing `react` to
// the app's own copy, any file reached through that island's require graph
// binds its hooks to a different React instance than the one actually
// rendering the tree — "Invalid hook call" / "Cannot read property
// 'useState' of null", reproduced on a real device via Expo Go over LAN.
//
// `react-dom`/`react-native`/`react-native-web` stay WEB-ONLY singletons:
// other workspace packages pin different React *DOM* versions (a web-only
// concern), and forcing `react-native/*` itself on native previously broke
// Expo's dev-runtime shims (e.g. getDevServer) — that regression was about
// react-native's own module graph, not react's, so redirecting only `react`
// here doesn't reintroduce it.
const ALL_PLATFORM_SINGLETONS = ['react'];
const WEB_ONLY_SINGLETONS = ['react-dom', 'react-native', 'react-native-web'];
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const singleton =
    ALL_PLATFORM_SINGLETONS.find(
      (name) => moduleName === name || moduleName.startsWith(`${name}/`),
    ) ||
    (platform === 'web' &&
      WEB_ONLY_SINGLETONS.find(
        (name) => moduleName === name || moduleName.startsWith(`${name}/`),
      ));
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
