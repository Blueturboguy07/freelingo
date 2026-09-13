/* global module */
/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: 'widget',
  name: 'FreelingoWidget',
  displayName: 'Freelingo',
  bundleIdentifier: '.widget',
  deploymentTarget: '16.4',
  exportJs: false,
  frameworks: ['SwiftUI', 'WidgetKit'],
  entitlements: {
    'com.apple.security.application-groups': [`group.${config.ios.bundleIdentifier}.widget`],
  },
  colors: { $accent: '#58CC02', $widgetBackground: '#FFFFFF' },
});
