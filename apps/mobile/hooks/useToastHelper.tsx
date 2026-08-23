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
    (message: string) => {
      toast.show({
        placement: 'bottom',
        duration: 2500,
        render: ({ id }) => (
          <Toast nativeID={`toast-${id}`} action="muted" variant="solid">
            <ToastDescription>{message}</ToastDescription>
          </Toast>
        ),
      });
    },
    [toast],
  );

  return { showToast };
}
