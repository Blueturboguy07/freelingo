import { useState } from 'react';
import { Pressable, Text } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';

function InteractiveFixture() {
  const [checked, setChecked] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Check answer"
      accessibilityState={{ disabled: checked }}
      disabled={checked}
      onPress={() => setChecked(true)}
    >
      <Text>{checked ? 'Checked' : 'Check'}</Text>
    </Pressable>
  );
}

it('the mobile harness drives the React Native component through a real DOM event', () => {
  render(<InteractiveFixture />);
  const button = screen.getByRole('button', { name: 'Check answer' });
  expect(button.getAttribute('aria-disabled')).not.toBe('true');
  fireEvent.click(button);
  expect(screen.getByText('Checked')).toBeDefined();
  expect(button.getAttribute('aria-disabled')).toBe('true');
});
