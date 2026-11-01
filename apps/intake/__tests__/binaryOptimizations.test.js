import {
  applyBinaryOptimizations,
  ALL_ABIS,
  PRODUCTION_ABIS,
} from '../plugins/withBinaryOptimizations';

const baseProps = () => [
  { type: 'comment', value: 'Enable GIF support in React Native images' },
  { type: 'property', key: 'expo.gif.enabled', value: 'true' },
  { type: 'property', key: 'reactNativeArchitectures', value: 'armeabi-v7a,arm64-v8a,x86,x86_64' },
  { type: 'property', key: 'EX_DEV_CLIENT_NETWORK_INSPECTOR', value: 'true' },
];

describe('withBinaryOptimizations plugin', () => {
  const property = (props, key) =>
    props.find((p) => p.type === 'property' && p.key === key)?.value;

  test('enables R8 minification and resource shrinking', () => {
    const props = applyBinaryOptimizations(baseProps(), { isProduction: false });
    expect(property(props, 'android.enableMinifyInReleaseBuilds')).toBe('true');
    expect(property(props, 'android.enableShrinkResourcesInReleaseBuilds')).toBe('true');
  });

  test('disables Fresco GIF support and the dev-client network inspector', () => {
    const props = applyBinaryOptimizations(baseProps(), { isProduction: false });
    expect(property(props, 'expo.gif.enabled')).toBe('false');
    expect(property(props, 'EX_DEV_CLIENT_NETWORK_INSPECTOR')).toBe('false');
  });

  test('restricts ABI splits to arm64-v8a for production profiles', () => {
    const props = applyBinaryOptimizations(baseProps(), { isProduction: true });
    expect(property(props, 'reactNativeArchitectures')).toBe(PRODUCTION_ABIS);
    expect(PRODUCTION_ABIS).toBe('arm64-v8a');
  });

  test('keeps all ABIs outside production profiles', () => {
    const props = applyBinaryOptimizations(baseProps(), { isProduction: false });
    expect(property(props, 'reactNativeArchitectures')).toBe(ALL_ABIS);
  });

  test('adds missing properties without duplicating existing ones', () => {
    const props = applyBinaryOptimizations([{ type: 'empty' }], { isProduction: false });
    expect(props.filter((p) => p.type === 'property')).toHaveLength(5);
  });
});
