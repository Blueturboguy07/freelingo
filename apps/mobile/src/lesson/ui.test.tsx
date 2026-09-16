import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button3D, UiProvider, Heading, BodyText } from '@freelingo/ui';

describe('P3 measured UI atoms', () => {
  it('[INV-TYP-14] EC-TYP-15 maps Bold Text body500→700 and label700→800 without collapsing hierarchy', () => {
    render(
      <UiProvider boldText>
        <BodyText testID="bold-body">Your answer</BodyText>
        <Button3D label="Continue" onPress={() => {}} testID="bold-button" />
      </UiProvider>,
    );
    expect(screen.getByTestId('bold-body').style.fontFamily).toContain('Nunito_700Bold');
    expect(screen.getByTestId('bold-button-label').style.fontFamily).toContain(
      'Nunito_800ExtraBold',
    );
  });
  it('P3 measured macaw CTA uses its declared #0096DD lip', () => {
    render(
      <UiProvider>
        <Button3D label="Next" tone="macaw" onPress={() => {}} testID="macaw" />
      </UiProvider>,
    );
    expect(screen.getByTestId('macaw').style.backgroundColor).toBe('rgb(0, 150, 221)');
  });

  it('[INV-A11Y-14] exposes one button with its precondition and blocks disabled taps', () => {
    const onPress = vi.fn();
    const { rerender } = render(
      <UiProvider>
        <Button3D
          label="Check"
          disabled
          accessibilityHint="Choose an answer first"
          onPress={onPress}
        />
      </UiProvider>,
    );
    const button = screen.getByRole('button', { name: 'Check' });
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.textContent).toBe('CHECK');
    const hintId = button.getAttribute('aria-describedby');
    expect(hintId).not.toBeNull();
    expect(document.getElementById(hintId!)?.textContent).toBe('Choose an answer first');
    fireEvent.click(button);
    expect(onPress).not.toHaveBeenCalled();
    rerender(
      <UiProvider>
        <Button3D label="Check" onPress={onPress} />
      </UiProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(onPress).toHaveBeenCalledOnce();
  });
  it('[INV-A11Y-14] renders high-contrast disabled colors from declared tokens', () => {
    render(
      <UiProvider highContrast>
        <Button3D label="Check" disabled onPress={() => {}} testID="check" />
      </UiProvider>,
    );
    expect(screen.getByTestId('check-label').style.color).toBe('rgb(220, 230, 236)');
    expect(screen.getByTestId('check-face').style.backgroundColor).toBe('rgb(55, 70, 79)');
  });
  it('[INV-TYP-19] keeps target script text and language with no uppercase or tracking', () => {
    render(
      <UiProvider>
        <Heading>Translate this sentence</Heading>
        <BodyText language="ja">直 令 骨 今 次 海</BodyText>
        <Button3D label="つづける" language="ja" onPress={() => {}} testID="continue" />
      </UiProvider>,
    );
    const label = screen.getByTestId('continue-label');
    expect(label.textContent).toBe('つづける');
    expect(label.style.letterSpacing).toBe('0px');
    expect(screen.getByText('直 令 骨 今 次 海').getAttribute('lang')).toBe('ja');
    expect(screen.getByRole('heading').textContent).toBe('Translate this sentence');
  });
});
