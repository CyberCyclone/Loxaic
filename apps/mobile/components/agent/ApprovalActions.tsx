import type { ReactNode } from 'react';
import { HStack } from '@/components/ui/hstack';
import { Button, ButtonText } from '@/components/ui/button';
import { useServerReachable } from '@/lib/connection';
import type { PermissionBarView } from '@/lib/permissionBar';

interface ApprovalActionsProps {
  view: PermissionBarView;
  /** Given only where "Allow always" may be offered at all. */
  onAllowAlways?: () => void;
  onAllow: () => void;
  onDeny: () => void;
  ids: { deny: string; allow: string; allowAlways: string; rule: string };
  denyLabel?: string;
  /** Before the answers, on the left: the bar's Details button. */
  leading?: ReactNode;
}

/**
 * The answers to a permission request, the same wherever it is asked — the
 * agent's bar, its details sheet and chat's sheet (#267). The same answers in
 * every mode, under the same ids; only which one is filled changes, and the
 * filled one is last, nearest the thumb.
 */
export function ApprovalActions({
  view,
  onAllowAlways,
  onAllow,
  onDeny,
  ids,
  denyLabel = 'Deny',
  leading,
}: ApprovalActionsProps) {
  // An answer needs an open socket; until then it could only be dropped (#231).
  const disconnected = !useServerReachable();
  const offerAlways = onAllowAlways !== undefined && view.canAllowAlways;
  const alwaysFirst = offerAlways && view.primary === 'always';
  return (
    <HStack space="sm" className="flex-wrap items-center justify-end">
      {leading}
      <Button testID={ids.deny} variant="outline" size="sm" onPress={onDeny} isDisabled={disconnected}>
        <ButtonText>{denyLabel}</ButtonText>
      </Button>
      {alwaysFirst ? (
        <Button testID={ids.allow} variant="outline" size="sm" onPress={onAllow} isDisabled={disconnected}>
          <ButtonText>Allow once</ButtonText>
        </Button>
      ) : null}
      {offerAlways ? (
        <Button
          testID={ids.allowAlways}
          variant={alwaysFirst ? 'default' : 'outline'}
          size="sm"
          onPress={onAllowAlways}
          isDisabled={disconnected}
        >
          <ButtonText testID={ids.rule}>{view.alwaysLabel ?? 'Allow always'}</ButtonText>
        </Button>
      ) : null}
      {alwaysFirst ? null : (
        <Button testID={ids.allow} size="sm" onPress={onAllow} isDisabled={disconnected}>
          <ButtonText>Allow once</ButtonText>
        </Button>
      )}
    </HStack>
  );
}
