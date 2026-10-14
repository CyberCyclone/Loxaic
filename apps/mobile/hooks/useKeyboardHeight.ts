import { useEffect, useState } from 'react';
import { Keyboard } from 'react-native';

/**
 * The on-screen keyboard's height, or 0 while it is hidden. Web never raises
 * these events, so it stays 0 there — a browser resizes the page instead.
 *
 * For an overlay the screen's own KeyboardAvoidingView cannot reach (a sheet,
 * a modal), which has to lift its footer itself or leave its buttons under the
 * keyboard.
 */
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', (e) => { setHeight(e.endCoordinates.height); });
    const hidden = Keyboard.addListener('keyboardDidHide', () => { setHeight(0); });
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  return height;
}
