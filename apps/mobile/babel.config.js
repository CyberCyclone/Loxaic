module.exports = function (api) {
  api.cache(true);

  return {
    presets: ['babel-preset-expo'],

    plugins: [
      [
        'module-resolver',
        {
          root: ['./'],

          alias: {
            '@': './',
          },
        },
      ],
      // `react-native-worklets/plugin` is NOT listed here on purpose:
      // babel-preset-expo (>= 54) injects it itself whenever the package is
      // installed, and listing it twice breaks reanimated.
    ],
  };
};
