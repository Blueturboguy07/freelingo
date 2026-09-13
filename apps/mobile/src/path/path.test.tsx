import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PathModel, PathNode } from '@freelingo/core/path';
import { PathScreen } from './index';
const node = (id: string, done = 0): PathNode => ({
  id,
  type: 'lesson',
  unitIndex: 0,
  subLessonsDone: done,
  subLessonsTotal: 2,
  legendary: false,
  introducesScriptUnits: [],
  requiresScriptUnits: [],
});
const model: PathModel = {
  manifest: {
    packId: 'test',
    languageName: 'Spanish',
    declaredNodeTypes: ['lesson'],
    legendaryDenominator: ['lesson'],
    scoreCeiling: 20,
    cefrChecked: true,
    sectionTitles: ['First steps'],
  },
  sections: [
    {
      index: 0,
      title: 'First steps',
      band: 'very early A1',
      units: [
        {
          index: 0,
          title: 'Talk about your home',
          colourIndex: 0,
          nodes: [node('a'), node('b'), node('c')],
        },
      ],
    },
  ],
  jumpUnlockedUnits: [],
  scoreEarned: 0,
  scoreFloor: 0,
  viewingSection: 0,
  dailyRefreshUnlocked: false,
  completedUnits: [],
  introducedScriptUnits: [],
};
function Harness({
  data = model,
  onLaunch = vi.fn(),
}: {
  data?: PathModel;
  onLaunch?: () => void;
}) {
  const [selectedNodeId, onSelectNode] = useState<string | null>(null);
  return (
    <PathScreen
      model={data}
      selectedNodeId={selectedNodeId}
      onSelectNode={onSelectNode}
      onLaunch={onLaunch}
      onOpenGuidebook={() => {}}
      onOpenSections={() => {}}
      onRepairPack={() => {}}
    />
  );
}
describe('measured path caller', () => {
  it('[INV-A11Y-13] accessibility order follows curriculum order despite serpentine offsets', () => {
    render(<Harness />);
    expect(screen.getAllByTestId(/^path-node-/).map((n) => n.getAttribute('data-testid'))).toEqual([
      'path-node-a',
      'path-node-b',
      'path-node-c',
    ]);
  });
  it('[INV-PATH-01] tapping a locked node gives the existing unlock explanation', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('path-node-b'));
    expect(screen.getByText('Complete all levels above to unlock this!')).toBeTruthy();
  });
  it('[INV-PATH-03] complete popup launches the real nodePractice flavour and omits START/counter', () => {
    const first = model.sections[0]!;
    const unit = first.units[0]!;
    const onLaunch = vi.fn();
    render(
      <Harness
        onLaunch={onLaunch}
        data={{
          ...model,
          sections: [
            { ...first, units: [{ ...unit, nodes: [node('a', 2), node('b'), node('c')] }] },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByTestId('path-node-a'));
    expect(screen.queryByText('Lesson 3 of 2')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Practice' }));
    expect(onLaunch).toHaveBeenCalledWith({ nodeId: 'a', unitIndex: 0, flavour: 'nodePractice' });
  });
  it('[INV-PATH-19] a missing pack has an actionable repair control', () => {
    const repair = vi.fn();
    render(
      <PathScreen
        model={null}
        status="pack-missing"
        selectedNodeId={null}
        onSelectNode={() => {}}
        onLaunch={() => {}}
        onOpenGuidebook={() => {}}
        onOpenSections={() => {}}
        onRepairPack={repair}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Verify or download course' }));
    expect(repair).toHaveBeenCalledOnce();
  });
});
