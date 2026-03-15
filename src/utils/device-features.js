'use strict';

export const DEVICE_FEATURE_PREFIXES = [
  'device/id/',
  'device/os/',
  'device/type/',
  'client/device/id/',
];

export function normalizeDeviceOs(value) {
  const input = String(value || '').trim().toLowerCase();
  if (!input) { return null; }
  if (input === 'darwin' || input === 'macos' || input === 'osx') { return 'mac'; }
  if (input === 'win32' || input === 'win' || input === 'windows_nt') { return 'windows'; }
  if (input === 'linux' || input === 'mac' || input === 'windows') { return input; }
  if (input === 'android' || input === 'ios' || input === 'server' || input === 'container') { return input; }
  return input;
}

export function normalizeDeviceType(value) {
  const input = String(value || '').trim().toLowerCase();
  return input || null;
}

export function buildDeviceFeatureTags(device = {}) {
  const tags = [];
  const deviceId = String(device.deviceId || '').trim();
  const deviceOs = normalizeDeviceOs(device.deviceOs || device.platform || device.os);
  const deviceType = normalizeDeviceType(device.deviceType || device.type);

  if (deviceId) { tags.push(`device/id/${deviceId}`); }
  if (deviceOs) { tags.push(`device/os/${deviceOs}`); }
  if (deviceType) { tags.push(`device/type/${deviceType}`); }

  return Array.from(new Set(tags));
}

export function stripDeviceFeatureTags(featureArray = []) {
  return (Array.isArray(featureArray) ? featureArray : []).filter((feature) =>
    typeof feature === 'string' &&
    !DEVICE_FEATURE_PREFIXES.some((prefix) => feature.startsWith(prefix))
  );
}

export function mergeDeviceFeatureTags(featureArray = [], device = {}) {
  return [
    ...stripDeviceFeatureTags(featureArray),
    ...buildDeviceFeatureTags(device),
  ];
}
