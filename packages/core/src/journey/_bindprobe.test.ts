import { describe, expect, it } from 'vitest';
import { bindEngine } from './bind.js';
describe('bind probe', () => {
  it('reports what is missing', async () => {
    const r = await bindEngine();
    console.log(JSON.stringify(r.missing, null, 1));
    console.log('day bound:', r.engine.day !== null);
    expect(true).toBe(true);
  });
});
