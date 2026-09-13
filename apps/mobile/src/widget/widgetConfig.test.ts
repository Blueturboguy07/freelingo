import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
const require = createRequire(import.meta.url);
it('[INV-PLAT-02][INV-WID-01] config declares the same explicit group for app and snapshot-only target', () => {
  const plugin = require('../../modules/widget-publication/app.plugin.js');
  const target = require('../../targets/widget/expo-target.config.js');
  const config = plugin({
    name: 'Freelingo',
    slug: 'freelingo',
    ios: { bundleIdentifier: 'org.freelingo.app', entitlements: { 'test.keep': true } },
  });
  expect(config.ios.entitlements).toEqual({
    'test.keep': true,
    'com.apple.security.application-groups': ['group.org.freelingo.app.widget'],
  });
  expect(config.ios.infoPlist.FreelingoWidgetAppGroup).toBe('group.org.freelingo.app.widget');
  expect(target(config)).toMatchObject({
    type: 'widget',
    name: 'FreelingoWidget',
    bundleIdentifier: '.widget',
    exportJs: false,
    entitlements: { 'com.apple.security.application-groups': ['group.org.freelingo.app.widget'] },
  });
  expect(() => plugin({ name: 'Freelingo', slug: 'freelingo', ios: {} })).toThrow(/bundle/);
});
