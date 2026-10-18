import type { BrowserSettings } from '@loxaic/api-client';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Switch } from '@/components/ui/switch';
import { Button, ButtonText } from '@/components/ui/button';
import { canEnableBrowsing, canInstallBrowser, describeBrowserStatus } from '@/lib/browserSettings';

interface WebBrowsingSettingsProps {
  settings: BrowserSettings;
  unavailable: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onInstall: () => void;
}

/** web_fetch's browser fallback (#281): the switch, Chromium's install, and
 * what the last launch said. */
export function WebBrowsingSettings({ settings, unavailable, onEnabledChange, onInstall }: WebBrowsingSettingsProps) {
  // Turning it off is always allowed; turning it on needs a browser.
  const switchDisabled = unavailable || settings.envOverrides.enabled || (!settings.enabled && !canEnableBrowsing(settings));
  return (
    <VStack space="xs">
      <Text size="xs" className="text-muted-foreground">
        Web browsing
      </Text>
      <HStack space="sm" className="items-center">
        <Switch
          testID="sandbox.browser.toggle"
          value={settings.enabled}
          onValueChange={onEnabledChange}
          isDisabled={switchDisabled}
        />
        <Text size="sm" className="flex-1 text-foreground">
          When a site refuses a plain fetch or needs JavaScript, load it in a browser, and let the model take screenshots
        </Text>
      </HStack>
      <Text testID="sandbox.browser.status" size="2xs" className="text-muted-foreground">
        {describeBrowserStatus(settings)}
      </Text>
      <Text size="2xs" className="text-muted-foreground">
        Each conversation gets its own browser, with nothing shared between conversations. Every request it makes is
        fetched by this server and refused if it points at a private or local address.
      </Text>
      {settings.envOverrides.enabled && (
        <Text size="2xs" className="text-muted-foreground">
          Set by the BROWSER_ENABLED environment variable.
        </Text>
      )}
      {canInstallBrowser(settings) && (
        <Button
          testID="sandbox.browser.install"
          size="sm"
          variant="outline"
          className="self-start"
          isDisabled={unavailable}
          onPress={onInstall}
        >
          <ButtonText>Install Chromium</ButtonText>
        </Button>
      )}
    </VStack>
  );
}
