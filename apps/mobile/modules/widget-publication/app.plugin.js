/* global require, module */
/* eslint-disable @typescript-eslint/no-require-imports */
// App Group wire identity, adopted 2026-09-13. Native generated directories stay disposable.
const { withInfoPlist, withEntitlementsPlist } = require('expo/config-plugins');
module.exports = function withWidgetPublication(config) {
  const bundle = config.ios?.bundleIdentifier;
  if (typeof bundle !== 'string' || !bundle.trim())
    throw new Error('Widget requires an explicit iOS bundle identifier');
  const group = `group.${bundle}.widget`;
  const previous = config.ios.entitlements?.['com.apple.security.application-groups'] ?? [];
  if (!Array.isArray(previous) || previous.some((v) => typeof v !== 'string'))
    throw new Error('Invalid existing App Groups');
  const groups = [...new Set([...previous, group])];
  config.ios = {
    ...config.ios,
    entitlements: { ...config.ios.entitlements, 'com.apple.security.application-groups': groups },
    infoPlist: { ...config.ios.infoPlist, FreelingoWidgetAppGroup: group },
  };
  config = withEntitlementsPlist(config, (c) => {
    c.modResults['com.apple.security.application-groups'] = groups;
    return c;
  });
  return withInfoPlist(config, (c) => {
    c.modResults.FreelingoWidgetAppGroup = group;
    return c;
  });
};
