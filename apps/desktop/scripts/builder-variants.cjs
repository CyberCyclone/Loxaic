// Two desktop apps out of one codebase: Loxaic and Loxaic Beta.
//
// `LOXAIC_VARIANT` decides which one is being packaged. A beta tester installs
// a *different application* — its own name, its own bundle id, its own data
// directory — so it sits beside the stable app rather than replacing it, and
// neither can update into the other. That replaces the old in-app channel
// switch, which could disagree with what the binary was actually following.
//
// This lives beside electron-builder.config.cjs rather than inside it because
// electron-builder validates the config object against its schema and rejects
// unknown properties — so the config file can export a config and nothing
// else, while the table and the function over it stay testable here.
//
// **One variant per tag is not required, and that is the point.** Both
// variants publish an update manifest, and the stable one is always
// `latest*.yml`; two of those in a single GitHub release would overwrite each
// other. The beta variant therefore pins `publish.channel: "beta"`, so it
// writes `beta*.yml` on *every* tag it is built for — which is what lets the
// release workflow build the beta app for a stable tag too, and is the whole
// reason a beta tester keeps receiving releases instead of being stranded on
// the last prerelease.
//
// Nothing sets LOXAIC_VARIANT yet: the release workflow packages both variants
// from its own matrix, and that arrives with the release-pipeline stage. Until
// then every build here is the stable app, which is the right default but
// means the beta feed described above has no artifacts behind it.

const VARIANTS = {
  production: {
    productName: "Loxaic",
    appId: "com.loxaic.desktop",
    artifactName: "Loxaic-${version}-${os}-${arch}.${ext}",
    executableName: "loxaic",
    // No `channel`: electron-builder defaults to "latest", which is what an
    // installed stable app asks /releases/latest for.
    channel: undefined,
  },
  beta: {
    productName: "Loxaic Beta",
    appId: "com.loxaic.desktop.beta",
    // Spelled out rather than derived from ${productName}, which contains a
    // space: an installer called "Loxaic Beta-1.2.3-mac-arm64.dmg" is a
    // download link nobody can paste without quoting.
    artifactName: "Loxaic-Beta-${version}-${os}-${arch}.${ext}",
    // Pinned rather than inferred. electron-builder derives the Linux
    // executable from the product name by lowercasing it *without* replacing
    // whitespace, so "Loxaic Beta" would become `loxaic beta` — a name with a
    // space in it, which is awkward in a .desktop entry and impossible to
    // guess from the outside. Naming it here makes it ours.
    executableName: "loxaic-beta",
    channel: "beta",
  },
};

function variantFor(raw) {
  const key = raw ?? "production";
  const variant = Object.hasOwn(VARIANTS, key) ? VARIANTS[key] : undefined;
  if (!variant) {
    throw new Error(`LOXAIC_VARIANT="${key}" is not one of ${Object.keys(VARIANTS).join(", ")}`);
  }
  return { key, ...variant };
}

function configFor(rawVariant) {
  const variant = variantFor(rawVariant);
  return {
    appId: variant.appId,
    productName: variant.productName,
    // The packaged package.json is how the *running* app learns which variant
    // it is — src/variant.js reads it. `productName` at the top level is also
    // what Electron reads for `app.name`, and therefore for `userData`:
    // without it Electron falls back to the package name (`@loxaic/desktop`)
    // and disagrees with `defaultDataDir()`. Setting it here fixes that for
    // both variants and is what keeps their data directories apart.
    extraMetadata: {
      productName: variant.productName,
      loxaicVariant: variant.key,
    },
    npmRebuild: false,
    // Deliberate, and load-bearing: Electron patches `child_process.execFile`
    // to read out of app.asar but not `spawn`, and embedded-postgres spawns
    // initdb/postgres from its own package paths. It also means src/ and the
    // packaged package.json are plain files the app can read at runtime.
    asar: false,
    files: ["src/**/*"],
    extraResources: [
      { from: "../mobile/dist", to: "web" },
      { from: "resources/tsnet-proxy", to: "tsnet-proxy" },
      { from: "resources/server", to: "server" },
    ],
    artifactName: variant.artifactName,
    publish: [
      {
        provider: "github",
        owner: "CyberCyclone",
        repo: "Open-Shannon",
        ...(variant.channel ? { channel: variant.channel } : {}),
      },
    ],
    mac: {
      target: ["dmg", "zip"],
      category: "public.app-category.developer-tools",
      hardenedRuntime: true,
      gatekeeperAssess: false,
      entitlements: "build/entitlements.mac.plist",
      entitlementsInherit: "build/entitlements.mac.plist",
      notarize: true,
    },
    win: { target: "nsis" },
    nsis: { oneClick: true },
    linux: {
      target: ["AppImage", "deb"],
      category: "Development",
      executableName: variant.executableName,
    },
  };
}

module.exports = { configFor, VARIANTS };
