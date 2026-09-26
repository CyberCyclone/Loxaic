import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Switch } from '@/components/ui/switch';
import type { SandboxRetention } from '@loxaic/api-client';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Offered as a fixed set rather than a free number field: these are the only
 * values that mean anything different in practice, and a text input invites a
 * "5" that could be minutes, hours, or days. Qualifiers are the values
 * themselves, per the testID convention. */
const IDLE_STOP_CHOICES = [
  { ms: 1 * HOUR_MS, label: '1h' },
  { ms: 4 * HOUR_MS, label: '4h' },
  { ms: 12 * HOUR_MS, label: '12h' },
  { ms: 24 * HOUR_MS, label: '24h' },
];

const REAP_AFTER_CHOICES = [
  { ms: 7 * DAY_MS, label: '7d' },
  { ms: 30 * DAY_MS, label: '30d' },
  { ms: 90 * DAY_MS, label: '90d' },
  { ms: 365 * DAY_MS, label: '1y' },
];

interface RetentionSettingsProps {
  retention: SandboxRetention;
  envOverrides: { idleStop: boolean; reapEnabled: boolean; reapAfter: boolean };
  onChange: (patch: Partial<SandboxRetention>) => void;
  /** The server cannot be reached to save a change right now. */
  unavailable?: boolean;
}

/**
 * How long an agent's workspace lives.
 *
 * The two timers are shown together and named for what they do, because their
 * difference is the whole point and neither label makes sense alone: one
 * pauses (nothing is lost), one deletes (everything is). A single "cleanup
 * after N hours" control would collapse them back into the behaviour this
 * replaced, where going to lunch cost you a checkout.
 */
export function RetentionSettings({ retention, envOverrides, onChange, unavailable = false }: RetentionSettingsProps) {
  return (
    <VStack space="sm">
      <Text size="xs" className="text-muted-foreground">
        Workspace retention
      </Text>

      <VStack space="xs">
        <Text size="sm" className="text-foreground">
          Pause a workspace after
        </Text>
        <HStack space="xs">
          {IDLE_STOP_CHOICES.map((choice) => (
            <Pressable
              key={choice.ms}
              testID={`sandbox.idleStop.${choice.label}`}
              disabled={envOverrides.idleStop || unavailable}
              onPress={() => { onChange({ idleStopMs: choice.ms }); }}
              className={`rounded-full px-3 py-1.5 ${
                retention.idleStopMs === choice.ms ? 'bg-primary/15' : 'bg-muted'
              } ${envOverrides.idleStop || unavailable ? 'opacity-40' : ''}`}
            >
              <Text size="sm" className={retention.idleStopMs === choice.ms ? 'text-primary' : 'text-muted-foreground'}>
                {choice.label}
              </Text>
            </Pressable>
          ))}
        </HStack>
        <Text testID="sandbox.idleStop.explainer" size="xs" className="text-muted-foreground">
          Idle that long and the container stops. Files, edits and installed dependencies are kept —
          the next message starts it again where it left off.
        </Text>
        {envOverrides.idleStop && (
          <Text size="2xs" className="text-muted-foreground">
            Set by the SANDBOX_IDLE_STOP_MS environment variable.
          </Text>
        )}
      </VStack>

      <VStack space="xs">
        <HStack space="sm" className="items-center">
          <Switch
            testID="sandbox.reap.enabled"
            value={retention.reapEnabled}
            onValueChange={(value) => { onChange({ reapEnabled: value }); }}
            isDisabled={envOverrides.reapEnabled || unavailable}
          />
          <Text size="sm" className="flex-1 text-foreground">
            Delete workspaces nobody has used in a long time
          </Text>
        </HStack>
        {retention.reapEnabled ? (
          <>
            <HStack space="xs">
              {REAP_AFTER_CHOICES.map((choice) => (
                <Pressable
                  key={choice.ms}
                  testID={`sandbox.reap.${choice.label}`}
                  disabled={envOverrides.reapAfter || unavailable}
                  onPress={() => { onChange({ reapAfterMs: choice.ms }); }}
                  className={`rounded-full px-3 py-1.5 ${
                    retention.reapAfterMs === choice.ms ? 'bg-primary/15' : 'bg-muted'
                  } ${envOverrides.reapAfter || unavailable ? 'opacity-40' : ''}`}
                >
                  <Text
                    size="sm"
                    className={retention.reapAfterMs === choice.ms ? 'text-primary' : 'text-muted-foreground'}
                  >
                    {choice.label}
                  </Text>
                </Pressable>
              ))}
            </HStack>
            <Text testID="sandbox.reap.explainer" size="xs" className="text-muted-foreground">
              Unused for that long and the workspace is deleted, along with any uncommitted work in
              it. This is the only automatic deletion there is.
            </Text>
          </>
        ) : (
          // The off state states its own cost rather than going blank, so an
          // admin can see what they are choosing between before they choose.
          <Text testID="sandbox.reap.explainer" size="xs" className="text-muted-foreground">
            Workspaces are kept until their conversation is deleted. Nothing is ever removed on a
            timer, and disk use grows with every conversation that ran a tool.
          </Text>
        )}
        {envOverrides.reapEnabled && (
          <Text size="2xs" className="text-muted-foreground">
            Set by the SANDBOX_REAP_ENABLED environment variable.
          </Text>
        )}
      </VStack>
    </VStack>
  );
}
