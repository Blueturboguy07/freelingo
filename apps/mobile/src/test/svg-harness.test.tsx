import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import Svg, { Path } from 'react-native-svg';
it('renders the native SVG import through the web test target', () => {
  const { container } = render(
    <Svg viewBox="0 0 10 10">
      <Path d="M1 1 L9 9" stroke="#58CC02" />
    </Svg>,
  );
  expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 10 10');
  expect(container.querySelector('path')?.getAttribute('d')).toBe('M1 1 L9 9');
});
