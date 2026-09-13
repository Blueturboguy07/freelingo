import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Component interaction tests render the same React Native components through RN Web.
// Native permissions, geometry, audio and accessibility still require Maestro evidence.
afterEach(cleanup);
