export default {
  test: {
    root: '/private/tmp/p3-spanish-revision3-review',
    include: ['first-session.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@freelingo/testkit': '/Users/mannbellani/freelingo-wt/p3-app/packages/testkit/src/index.ts',
    },
  },
};
