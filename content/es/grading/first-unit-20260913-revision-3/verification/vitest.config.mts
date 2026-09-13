import { fileURLToPath } from 'node:url';
export default {
  test: {
    environment: 'node',
    include: [fileURLToPath(new URL('./first-session.test.ts', import.meta.url))],
  },
};
