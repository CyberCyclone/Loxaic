import type { ExpoConfig } from "expo/config";

// APP_VARIANT=development builds a separate "Shannon Dev" app — its own
// bundle id and URL scheme, and therefore its own AsyncStorage/SecureStore —
// so a dev build and the stable app install side-by-side on one device with
// independent sessions, settings, and endpoint overrides. The variant is set
// by this package's start/ios/android scripts and by eas.json's development
// profile; anything else builds the stable identity. (Expo Go is unaffected:
// it sandboxes per-project regardless of bundle id.)
const IS_DEV = process.env.APP_VARIANT === "development";

const config: ExpoConfig = {
  name: IS_DEV ? "Shannon Dev" : "open-shannon",
  slug: "open-shannon",
  version: "0.0.1",
  orientation: "portrait",
  scheme: IS_DEV ? "openshannon-dev" : "openshannon",
  userInterfaceStyle: "automatic",
  newArchEnabled: true,
  ios: {
    supportsTablet: true,
    bundleIdentifier: IS_DEV ? "com.shannon.app.dev" : "com.shannon.app",
  },
  android: {
    adaptiveIcon: {
      backgroundColor: "#18181b",
    },
    package: IS_DEV ? "com.shannon.app.dev" : "com.shannon.app",
  },
  web: {
    bundler: "metro",
    output: "single",
  },
  plugins: ["expo-router", "expo-secure-store", "expo-font"],
  extra: {
    router: {},
    eas: {
      projectId: "78ef6ddc-9619-4afe-91e6-9370e4c3fc70",
    },
  },
  owner: "caseygibson",
  runtimeVersion: {
    policy: "sdkVersion",
  },
  updates: {
    url: "https://u.expo.dev/78ef6ddc-9619-4afe-91e6-9370e4c3fc70",
  },
};

export default config;
