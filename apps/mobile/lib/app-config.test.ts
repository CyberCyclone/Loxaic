import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * app.config.js is what makes dev, beta and production three separate apps, and
 * every one of its outputs is load-bearing in a way that fails silently: a
 * wrong bundle identifier installs over the wrong app, and a wrong channel
 * header produces a build that receives updates nobody published to it. None
 * of that shows up until a real device has the wrong thing on it, so it is
 * asserted here instead.
 */
const require_ = createRequire(import.meta.url);
interface AppConfig {
  expo: Record<string, unknown>;
}
type ConfigFn = (args: { config: Record<string, unknown> }) => Record<string, unknown>;

const appJson = require_('../app.json') as AppConfig;
const configFn = require_('../app.config.js') as ConfigFn;

/** The shape Expo passes in: app.json's `expo` block, already parsed. */
function build(variant?: string) {
  if (variant === undefined) delete process.env.APP_VARIANT;
  else process.env.APP_VARIANT = variant;
  return configFn({ config: { ...appJson.expo } });
}

afterEach(() => {
  delete process.env.APP_VARIANT;
});

describe('app variants', () => {
  it.each([
    ['production', 'Loxaic', 'com.loxaic.app', 'loxaic', 'production'],
    ['beta', 'Loxaic Beta', 'com.loxaic.app.beta', 'loxaic-beta', 'beta'],
    ['dev', 'Loxaic Dev', 'com.loxaic.app.dev', 'loxaic-dev', 'dev'],
  ])('%s is its own app', (variant, name, id, scheme, channel) => {
    const config = build(variant);
    expect(config.name).toBe(name);
    expect(config.scheme).toBe(scheme);
    // Both platforms, because installing over the wrong app is the failure
    // this exists to prevent and it is per-platform.
    expect((config.ios as { bundleIdentifier: string }).bundleIdentifier).toBe(id);
    expect((config.android as { package: string }).package).toBe(id);
    expect((config.updates as { requestHeaders: Record<string, string> }).requestHeaders).toEqual({
      'expo-channel-name': channel,
    });
  });

  it('builds production when nothing asked for a variant', () => {
    // `expo start`, Expo Go, and a plain `expo export` all arrive here.
    const config = build(undefined);
    expect(config.name).toBe('Loxaic');
    expect((config.ios as { bundleIdentifier: string }).bundleIdentifier).toBe('com.loxaic.app');
  });

  it('refuses a variant it does not know rather than guessing', () => {
    // A typo in a build profile must not quietly ship as production.
    expect(() => build('prod')).toThrow(/APP_VARIANT="prod"/);
  });

  it.each(['constructor', 'toString', 'valueOf'])(
    'refuses %s, which a plain lookup would have found on the prototype',
    (key) => {
      // A prototype hit produced an app named `undefined`, the identifier
      // `com.loxaic.appundefined`, and — the one that costs a release — no
      // `expo-channel-name` header at all: a build following no channel, which
      // receives no updates for its whole life and says nothing about it.
      expect(() => build(key)).toThrow(/is not one of/);
    },
  );

  it('refuses an empty APP_VARIANT rather than defaulting it to production', () => {
    // What a declared-but-unset CI variable expands to. Defaulting it would
    // embed `production` in a build whose update CI publishes to `beta` — an
    // update that reaches nobody, silently. See the note in app.config.js.
    expect(() => build('')).toThrow(/APP_VARIANT=""/);
  });

  it('derives identifiers from app.json rather than repeating the base', () => {
    // app.json is the file that looks like the source of truth for identity;
    // hard-coding the base here made its copy dead, so a rename there would
    // have changed nothing while prebuild kept using the old identifier.
    const base = (appJson.expo.ios as { bundleIdentifier: string }).bundleIdentifier;
    const config = configFn({
      config: { ...appJson.expo, ios: { bundleIdentifier: 'com.example.renamed' } },
    });
    expect((config.ios as { bundleIdentifier: string }).bundleIdentifier).toBe(
      'com.example.renamed',
    );
    expect(base).not.toBe('com.example.renamed');
  });

  it('passes version through untouched, which is the release stamp contract', () => {
    // apps/desktop/scripts/stamp-version.mjs writes the tag into app.json and
    // nothing else; if this file ever computed a version, the stamp would be
    // writing to a field no build reads.
    expect(build('beta').version).toBe(appJson.expo.version);
  });

  it('keeps one slug and one EAS project across all three', () => {
    // Three slugs would mean three EAS projects, three sets of credentials,
    // and three places to publish an update to.
    for (const variant of ['production', 'beta', 'dev']) {
      const config = build(variant);
      expect(config.slug).toBe(appJson.expo.slug);
      expect((config.updates as { url: string }).url).toBe(
        (appJson.expo.updates as { url: string }).url,
      );
    }
  });

  it('records which variant it is, for anything that needs to ask at runtime', () => {
    expect((build('dev').extra as { variant: string }).variant).toBe('dev');
  });
});
