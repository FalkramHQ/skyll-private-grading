const productionOrigin = 'https://www.skyllai.com';
const configuredOrigin = String(process.env.EXPO_PUBLIC_API_ORIGIN || '').trim();
if (configuredOrigin && configuredOrigin !== productionOrigin) {
  throw new Error(`Release configuration must target ${productionOrigin}; received ${configuredOrigin}`);
}
console.log(`Release API target verified: ${productionOrigin}`);
