// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseSharedWidgetSnapshot, renderWidget, type WidgetRender } from '@freelingo/core/widget';
const fixtures = JSON.parse(
  readFileSync(
    new URL('../../modules/widget-publication/tests/snapshot-fixtures.json', import.meta.url),
    'utf8',
  ),
) as readonly {
  name: string;
  snapshotJson: string | null;
  nowMs: number;
  zone: string;
  expected: WidgetRender;
}[];
it.each(fixtures)(
  '[INV-WID-01][INV-WID-02][INV-WID-03][INV-WID-06][INV-WID-10] native fixture $name stays bound to the original core contract',
  (row) => {
    expect(renderWidget(parseSharedWidgetSnapshot(row.snapshotJson), row.nowMs, row.zone)).toEqual(
      row.expected,
    );
  },
);
