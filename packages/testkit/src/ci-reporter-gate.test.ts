import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../../..');

describe('CI reporter regression gate', () => {
  it('runs the property suite with the quiet dot reporter and records wall time', () => {
    const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');

    expect(workflow).toContain('time pnpm test -- --reporter=dot');
    expect(workflow).not.toMatch(/run:\s+pnpm test\s*(?:\n|$)/);
  });
});
