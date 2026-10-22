import { useMemo, useState } from 'react';
import { Linking, SectionList } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Modal,
  ModalBackdrop,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalCloseButton,
} from '@/components/ui/modal';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Heading } from '@/components/ui/heading';
import { Pressable } from '@/components/ui/pressable';
import { Icon, CloseIcon } from '@/components/ui/icon';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import {
  SHORT_SHA,
  commitUrl,
  loadChangelog,
  ticketUrl,
  type ChangeEntry,
  type Changelog,
} from '@/lib/changelog';

/**
 * What each release changed, from the changelog bundled with this build. Full
 * screen on a phone, where a centred card would leave the titles a few words
 * wide; a centred modal anywhere wider. Opened from Settings, which closes
 * first (AppShell swaps them): modals never stack.
 */
export function ChangelogModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Read on the first opening, not when AppShell mounts this for every user,
  // and kept after it: the file never changes under a running bundle, and the
  // modal still needs it while it animates out. `undefined` is "not read yet".
  const [changelog, setChangelog] = useState<Changelog | null | undefined>(undefined);
  if (open && changelog === undefined) setChangelog(loadChangelog());
  const sections = useMemo<Section[]>(() => {
    if (!changelog) return [];
    const newest = changelog.releases.at(0);
    return [
      ...(changelog.unreleased.length > 0
        ? [{ id: 'unreleased', title: 'Unreleased', subtitle: newest ? `Since ${newest.tag}` : 'In this build', data: changelog.unreleased }]
        : []),
      ...changelog.releases.map((r) => ({ id: r.tag, title: r.tag, subtitle: r.date, data: r.entries })),
    ];
  }, [changelog]);
  const fullScreen = useBreakpoint() === 'narrow';
  const insets = useSafeAreaInsets();
  const repoUrl = changelog?.repoUrl ?? null;

  return (
    <Modal isOpen={open} onClose={onClose} size={fullScreen ? 'full' : 'lg'}>
      <ModalBackdrop />
      <ModalContent
        testID="changelog.modal"
        className={fullScreen ? 'h-full w-full rounded-none border-0' : 'max-h-[85%]'}
        style={fullScreen ? { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 } : undefined}
      >
        <ModalHeader>
          <Heading size="sm">Changelog</Heading>
          <ModalCloseButton testID="changelog.close">
            <Icon as={CloseIcon} />
          </ModalCloseButton>
        </ModalHeader>
        {!changelog ? (
          <ModalBody>
            <Text testID="changelog.empty" size="sm" className="text-muted-foreground">
              This build doesn&apos;t include its changelog.
            </Text>
          </ModalBody>
        ) : (
          // Virtualised, not a ModalBody: the whole history is hundreds of rows
          // and grows every release, and nobody reads most of it. flexShrink
          // keeps it inside the modal's height cap, or the full screen, and
          // scrolling.
          <SectionList
            testID="changelog.list"
            sections={sections}
            keyExtractor={(entry) => entry.sha}
            stickySectionHeadersEnabled={false}
            initialNumToRender={20}
            style={{ flexShrink: 1, marginTop: 8 }}
            renderSectionHeader={({ section }) => (
              <HStack testID={`changelog.release.${section.id}`} space="sm" className="items-baseline pb-2 pt-4">
                <Text testID={`changelog.release.${section.id}.title`} size="md" bold className="text-foreground">
                  {section.title}
                </Text>
                <Text size="xs" className="text-muted-foreground">
                  {section.subtitle}
                </Text>
              </HStack>
            )}
            renderItem={({ item, section }) => <Entry sectionId={section.id} entry={item} repoUrl={repoUrl} />}
            renderSectionFooter={({ section }) => (
              <VStack space="sm" className="pb-2">
                {section.data.length === 0 && (
                  <Text size="sm" className="text-muted-foreground">
                    No changes of its own.
                  </Text>
                )}
                <Box className="h-px bg-border" />
              </VStack>
            )}
          />
        )}
      </ModalContent>
    </Modal>
  );
}

interface Section {
  id: string;
  title: string;
  subtitle: string;
  data: ChangeEntry[];
}

function Entry({ sectionId, entry, repoUrl }: { sectionId: string; entry: ChangeEntry; repoUrl: string | null }) {
  const short = entry.sha.slice(0, SHORT_SHA);
  // Scoped to its section: a stable release lists its betas' commits again.
  const id = `changelog.entry.${sectionId}.${short}`;
  return (
    <VStack space="xs" className="pb-3">
      <Text testID={`${id}.title`} size="sm" className="text-foreground">
        {entry.title}
      </Text>
      <HStack space="sm" className="flex-wrap">
        {entry.tickets.map((n) => (
          <Ref key={n} testID={`${id}.ticket.${String(n)}`} label={`#${String(n)}`} url={ticketUrl(repoUrl, n)} />
        ))}
        <Ref testID={`${id}.commit`} label={short} url={commitUrl(repoUrl, entry.sha)} mono />
      </HStack>
    </VStack>
  );
}

/** A ticket or commit: a link when the build knows its repository, plain text when not. */
function Ref({ testID, label, url, mono }: { testID: string; label: string; url: string | null; mono?: boolean }) {
  const text = (
    <Text
      testID={`${testID}.label`}
      size="xs"
      className={`${url ? 'text-primary' : 'text-muted-foreground'}${mono ? ' font-mono' : ''}`}
    >
      {label}
    </Text>
  );
  if (!url) return text;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="link"
      onPress={() => {
        void Linking.openURL(url).catch(() => {
          /* no browser to hand it to — nothing sensible to do */
        });
      }}
      hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
      className="rounded-sm web:hover:underline"
    >
      {text}
    </Pressable>
  );
}
