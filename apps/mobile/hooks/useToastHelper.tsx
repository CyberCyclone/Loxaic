import { useCallback } from 'react';
import { useToast as useGluestackToast, Toast, ToastDescription } from '@/components/ui/toast';

/**
 * Simple single-message toast, matching the design system's `showToast(msg)`
 * call signature. Wraps gluestack's toast (global, portal-rendered, queued)
 * instead of the web version's manual `document.body.appendChild` singleton.
 */
export function useToastHelper() {
  const toast = useGluestackToast();

  const showToast = useCallback(
    (message: string, duration = 2500) => {
      toast.show({
        placement: 'bottom',
        duration,
        // A toast is the only place several refusals are ever shown — a
        // workspace the server would not create, a git action that failed — so
        // without a testID none of them could be asserted from a spec. Safe
        // here: this directory has no `.web.tsx` override, and Toast spreads
        // its props onto a react-native View, which react-native-web maps to
        // `data-testid` on its own.
        render: ({ id }) => (
          <Toast testID="shell.toast" nativeID={`toast-${id}`} action="muted" variant="solid">
            <ToastDescription>{message}</ToastDescription>
          </Toast>
        ),
      });
    },
    [toast],
  );

  return { showToast };
}
