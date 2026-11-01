import * as FileSystem from 'expo-file-system/legacy';

export async function prepareScanUpload(uri) {
  const info = await FileSystem.getInfoAsync(uri);
  return {
    uri,
    byteSize: Number(info.size) || 0,
    checksum: null,
  };
}

export async function activateUploadKeepAwake(enabled = true) {
  // Dynamic import so an OTA JS bundle does not statically require a native
  // module that older store builds may not ship.
  try {
    const keepAwake = await import('expo-keep-awake');
    if (enabled) {
      if (typeof keepAwake.activateKeepAwakeAsync === 'function') {
        await keepAwake.activateKeepAwakeAsync('skyll-upload');
      } else if (typeof keepAwake.activateKeepAwake === 'function') {
        keepAwake.activateKeepAwake('skyll-upload');
      }
      return;
    }
    if (typeof keepAwake.deactivateKeepAwakeAsync === 'function') {
      await keepAwake.deactivateKeepAwakeAsync('skyll-upload');
    } else if (typeof keepAwake.deactivateKeepAwake === 'function') {
      keepAwake.deactivateKeepAwake('skyll-upload');
    }
  } catch {
    // Expo Go and some store builds omit keep-awake; uploads still proceed.
  }
}
