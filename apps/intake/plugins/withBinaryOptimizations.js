const { withGradleProperties } = require('@expo/config-plugins');

const PRODUCTION_PROFILES = new Set(['production', 'production-apk', 'preview']);

const ALL_ABIS = 'armeabi-v7a,arm64-v8a,x86,x86_64';
const PRODUCTION_ABIS = 'arm64-v8a';

function setProperty(props, key, value) {
  const index = props.findIndex((item) => item.type === 'property' && item.key === key);
  if (index >= 0) {
    props[index] = { type: 'property', key, value };
  } else {
    props.push({ type: 'property', key, value });
  }
  return props;
}

function applyBinaryOptimizations(props, { isProduction }) {
  setProperty(props, 'android.enableMinifyInReleaseBuilds', 'true');
  setProperty(props, 'android.enableShrinkResourcesInReleaseBuilds', 'true');
  setProperty(props, 'expo.gif.enabled', 'false');
  setProperty(props, 'EX_DEV_CLIENT_NETWORK_INSPECTOR', 'false');
  setProperty(
    props,
    'reactNativeArchitectures',
    isProduction ? PRODUCTION_ABIS : ALL_ABIS
  );
  return props;
}

const withBinaryOptimizations = (config) =>
  withGradleProperties(config, (cfg) => {
    const profile = process.env.EAS_BUILD_PROFILE;
    const isProduction = PRODUCTION_PROFILES.has(profile);
    cfg.modResults = applyBinaryOptimizations(cfg.modResults, { isProduction });
    return cfg;
  });

module.exports = withBinaryOptimizations;
module.exports.applyBinaryOptimizations = applyBinaryOptimizations;
module.exports.PRODUCTION_PROFILES = PRODUCTION_PROFILES;
module.exports.ALL_ABIS = ALL_ABIS;
module.exports.PRODUCTION_ABIS = PRODUCTION_ABIS;
