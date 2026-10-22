# loxaic-dev (#320): Loxaic's own sandbox image, plus what it takes to test
# Loxaic inside a Loxaic agent chat — Postgres, Chrome and chromedriver,
# Electron's libraries and Xvfb, the Android SDK and an emulator. Built on top
# of the real sandbox image (docker-bake.hcl names it as the `sandbox`
# context), so everything Loxaic's tools need is already here.
#
# amd64 only: Google publishes no Chrome or chromedriver for Linux on ARM, and
# the emulator's x86_64 system image needs an x86 host with KVM anyway.
#
# The lanes run through `loxaic-test` (loxaic-test.sh), which starts each one
# detached so it outlives the agent's 60-second tool call.
FROM sandbox

USER root

# Chrome for Testing and the chromedriver of the same build. Google publishes
# no checksums for these, so the version is the pin; selftest.sh checks the
# two agree. To move it, take a Stable version from
# https://googlechromelabs.github.io/chrome-for-testing/.
ARG CHROME_VERSION=156.0.8078.47
# The Android command-line tools: the `_latest` build number and its SHA-1,
# from https://dl.google.com/android/repository/repository2-3.xml (the only
# checksum Google lists for it).
ARG ANDROID_CMDLINE_TOOLS=16111833
ARG ANDROID_CMDLINE_TOOLS_SHA1=e025545c62a8e64c7559119566a569fb1dec5f60
# What a React Native 0.86 release build asks for (react-native's
# gradle/libs.versions.toml): compileSdk, buildTools and the NDK. Anything else
# Gradle wants it fetches itself into ANDROID_HOME, which loxaic owns.
ARG ANDROID_PLATFORM=android-36
ARG ANDROID_BUILD_TOOLS=36.0.0
ARG ANDROID_NDK=27.1.12297006
ARG ANDROID_CMAKE=3.22.1
ARG ANDROID_SYSTEM_IMAGE="system-images;android-35;google_apis;x86_64"

# Postgres 17 from PGDG, matching CI and the Compose file. No cluster is made
# at install: loxaic-test makes one as the sandbox's own user, which is the
# only user a Loxaic sandbox can run it as.
RUN set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends gnupg unzip zip xz-utils jq lsof procps; \
    install -d /usr/share/postgresql-common/pgdg; \
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      | gpg --dearmor -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg; \
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg] https://apt.postgresql.org/pub/repos/apt noble-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends postgresql-common; \
    sed -i 's/^#\?create_main_cluster.*/create_main_cluster = false/' /etc/postgresql-common/createcluster.conf; \
    apt-get install -y --no-install-recommends postgresql-17 postgresql-client-17; \
    rm -rf /var/lib/apt/lists/*

# Chrome's and Electron's shared libraries, a virtual display for Electron,
# the fonts pages render with, a JDK for Gradle, and the emulator's libraries.
RUN set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 \
      libdbus-1-3 libdrm2 libexpat1 libgbm1 libglib2.0-0t64 libgtk-3-0t64 libnspr4 libnss3 \
      libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 \
      libxfixes3 libxi6 libxkbcommon0 libxrandr2 libxrender1 libxshmfence1 libxss1 libxtst6 \
      libsecret-1-0 libnotify4 libvulkan1 libpulse0 libgl1 libegl1 libxkbfile1 \
      fonts-liberation fonts-noto-color-emoji xdg-utils \
      xvfb xauth \
      openjdk-17-jdk-headless; \
    rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    base="https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64"; \
    curl -fsSL -o /tmp/chrome.zip "$base/chrome-linux64.zip"; \
    curl -fsSL -o /tmp/chromedriver.zip "$base/chromedriver-linux64.zip"; \
    mkdir -p /opt/chrome; \
    unzip -q /tmp/chrome.zip -d /opt/chrome; \
    unzip -q /tmp/chromedriver.zip -d /opt/chrome; \
    rm /tmp/chrome.zip /tmp/chromedriver.zip

# pnpm at the version the repository pins (package.json's packageManager).
RUN npm install -g pnpm@10.4.1 && npm cache clean --force

ENV ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64

RUN set -eu; \
    curl -fsSL -o /tmp/cmdline-tools.zip \
      "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_TOOLS}_latest.zip"; \
    echo "${ANDROID_CMDLINE_TOOLS_SHA1}  /tmp/cmdline-tools.zip" | sha1sum -c -; \
    mkdir -p "$ANDROID_HOME/cmdline-tools"; \
    unzip -q /tmp/cmdline-tools.zip -d "$ANDROID_HOME/cmdline-tools"; \
    mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"; \
    rm /tmp/cmdline-tools.zip; \
    yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null; \
    "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --install \
      "platform-tools" "emulator" \
      "platforms;${ANDROID_PLATFORM}" "build-tools;${ANDROID_BUILD_TOOLS}" \
      "ndk;${ANDROID_NDK}" "cmake;${ANDROID_CMAKE}" \
      "${ANDROID_SYSTEM_IMAGE}" >/dev/null; \
    chown -R loxaic:loxaic "$ANDROID_HOME"

COPY loxaic-test.sh /usr/local/bin/loxaic-test
COPY profile.sh /etc/profile.d/loxaic-dev.sh
RUN chmod 0755 /usr/local/bin/loxaic-test && chmod 0644 /etc/profile.d/loxaic-dev.sh

# Read by the e2e harness (apps/e2e/README.md, "Inside a Loxaic sandbox") and
# by loxaic-test. PATH is set here as well as in the profile script, because
# the agent's commands run in a login shell but Loxaic's own execs do not.
ENV CHROME_BIN=/opt/chrome/chrome-linux64/chrome \
    CHROMEDRIVER_BIN=/opt/chrome/chromedriver-linux64/chromedriver \
    E2E_CHROME_NO_SANDBOX=1 \
    E2E_SANDBOX_MODE=host \
    E2E_PORT=4055 \
    DATABASE_URL=postgresql://postgres:postgres@localhost:5432/loxaic \
    PATH=/usr/lib/postgresql/17/bin:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/android-sdk/emulator:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

USER loxaic

# The emulator's device, made once here so the first Android lane only boots
# it. And Gradle's memory, from apps/e2e/README.md: the defaults expo prebuild
# writes die in KSP and lint on a release build.
RUN set -eu; \
    echo no | avdmanager create avd -n loxaic -k "${ANDROID_SYSTEM_IMAGE}" -d pixel_6 >/dev/null; \
    mkdir -p /home/loxaic/.gradle; \
    printf 'org.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1g\norg.gradle.daemon=false\n' > /home/loxaic/.gradle/gradle.properties

WORKDIR /home/loxaic
