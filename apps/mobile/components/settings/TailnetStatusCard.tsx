import { useState } from 'react';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Button, ButtonText } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useInstanceState } from '@/hooks/useInstanceState';
import { electronBridge } from '@/lib/endpoint';

/**
 * The embedded Tailscale sidecar's state, wherever a person needs to see it:
 * the login screen a fresh host lands on right after choosing to expose
 * itself (the one time approval is certain to be needed), Settings' Server
 * section, and the client onboarding step while a probe waits for the join.
 *
 * Renders nothing when no sidecar is running, and nothing at all off the
 * desktop app, so it can be mounted on shared screens.
 *
 * "Open in browser" asks the main process to open the link *it* received —
 * the renderer never hands it a URL — which is why the button has no href.
 */
export function TailnetStatusCard({ testIDPrefix }: { testIDPrefix: string }) {
  const state = useInstanceState();
  const [copied, setCopied] = useState(false);
  const tailnet = state?.tailnet;
  if (!tailnet || tailnet.state === 'off') return null;

  const bridge = electronBridge();
  const approve = () => { void bridge?.tailnet.openAuthUrl(); };
  const retry = () => { void bridge?.tailnet.restart(); };
  const copy = () => {
    if (!tailnet.url) return;
    // Electron's renderer is a web context; the clipboard API is what it has.
    const clipboard = (globalThis as { navigator?: { clipboard?: { writeText: (s: string) => Promise<void> } } }).navigator?.clipboard;
    void clipboard?.writeText(tailnet.url).then(() => {
      setCopied(true);
      setTimeout(() => { setCopied(false); }, 1500);
    });
  };

  return (
    <Box testID={testIDPrefix} className="rounded-md border border-border bg-card px-3 py-2.5">
      {tailnet.state === 'starting' && (
        <HStack space="sm" className="items-center">
          {/* Spinner, never ButtonSpinner: the latter reads its parent Button's
              style context and throws without one — which took the whole
              React tree down, leaving a blank window for exactly the second
              a fresh host spends here. */}
          <Spinner size="small" />
          <Text size="sm" className="text-foreground">Joining your tailnet…</Text>
        </HStack>
      )}

      {tailnet.state === 'needs-auth' && (
        <VStack space="xs">
          <Text size="sm" className="font-medium text-foreground">Approve this machine on your tailnet</Text>
          <Text size="2xs" className="text-muted-foreground">
            Tailscale needs you to approve this machine once. Open the link, sign in to your
            Tailscale account, and approve it — this card updates by itself.
          </Text>
          <HStack space="sm" className="items-center">
            <Button testID={`${testIDPrefix}.approve`} size="sm" onPress={approve}>
              <ButtonText>Open in browser</ButtonText>
            </Button>
            <Text testID={`${testIDPrefix}.authUrl`} size="2xs" className="flex-1 font-mono text-muted-foreground" numberOfLines={1}>
              {tailnet.authUrl}
            </Text>
          </HStack>
        </VStack>
      )}

      {tailnet.state === 'up' && (
        <VStack space="xs">
          {tailnet.mode === 'serve' ? (
            <>
              <Text size="sm" className="font-medium text-foreground">
                {tailnet.funnel ? 'On your tailnet and the internet' : 'On your tailnet'}
              </Text>
              <HStack space="sm" className="items-center">
                <Text testID={`${testIDPrefix}.url`} size="sm" className="flex-1 font-mono text-foreground" numberOfLines={1}>
                  {tailnet.url}
                </Text>
                <Button testID={`${testIDPrefix}.copy`} variant="outline" size="sm" onPress={copy}>
                  <ButtonText>{copied ? 'Copied' : 'Copy'}</ButtonText>
                </Button>
              </HStack>
              <Text size="2xs" className="text-muted-foreground">
                {tailnet.funnel
                  ? 'Anyone with this address can reach the sign-in page. Phones need no Tailscale app.'
                  : 'Devices on your tailnet reach you here. Phones need the Tailscale app.'}
              </Text>
            </>
          ) : (
            <Text testID={`${testIDPrefix}.url`} size="sm" className="text-foreground">
              Connected through your tailnet.
            </Text>
          )}
        </VStack>
      )}

      {tailnet.state === 'error' && (
        <VStack space="xs">
          <Text size="sm" className="font-medium text-destructive">Tailscale isn&apos;t working</Text>
          <Text testID={`${testIDPrefix}.error`} size="2xs" className="text-destructive">
            {tailnet.error}
          </Text>
          <HStack>
            <Button testID={`${testIDPrefix}.retry`} variant="outline" size="sm" onPress={retry}>
              <ButtonText>Try again</ButtonText>
            </Button>
          </HStack>
        </VStack>
      )}
    </Box>
  );
}
