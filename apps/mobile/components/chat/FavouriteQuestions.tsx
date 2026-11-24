import { useState } from 'react';
import { Plus, X } from 'lucide-react-native';
import { Box } from '@/components/ui/box';
import { VStack } from '@/components/ui/vstack';
import { HStack } from '@/components/ui/hstack';
import { Heading } from '@/components/ui/heading';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useFavouriteQuestions } from '@/hooks/useFavouriteQuestions';
import { useServerReachable } from '@/lib/connection';
import { useSession } from '@/lib/session';
import { favouritesView } from '@/lib/favouriteQuestions';
import { AddFavouriteModal } from './AddFavouriteModal';

/**
 * The new-chat screen: the person's favourite questions, each sent as it is
 * with one tap, and a way to add or remove them. Mounted afresh each time a
 * new chat opens, so a change made on another device shows here.
 *
 * Every control needs the server (a tap sends, add and remove write), so each
 * is off while it is unreachable; what was loaded stays readable.
 */
export function FavouriteQuestions({ onPick }: { onPick: (text: string) => void }) {
  const breakpoint = useBreakpoint();
  const columns = breakpoint === 'narrow' ? 1 : 2;
  const { token } = useSession();
  const { load, refresh, add, remove } = useFavouriteQuestions(token);
  const reachable = useServerReachable();
  const [adding, setAdding] = useState(false);
  const view = favouritesView(load, reachable);
  const width = columns === 1 ? '100%' : '48%';

  const addButton = (
    <Pressable
      testID="favourites.add"
      accessibilityLabel="Add a favourite question"
      disabled={!reachable}
      onPress={() => { setAdding(true); }}
      className={`flex-row items-center justify-center gap-2 rounded-md border border-dashed border-border p-4 web:hover:bg-muted/30 ${reachable ? '' : 'opacity-40'}`}
      style={{ width }}
    >
      <Icon as={Plus} size="sm" className="text-muted-foreground" />
      <Text className="text-muted-foreground">Add a favourite question</Text>
    </Pressable>
  );

  return (
    <Box className="flex-1 items-center justify-center p-6">
      <VStack space="md" className="w-full max-w-[500px] items-center">
        <Heading size="lg" className="text-foreground">
          How can I help?
        </Heading>
        {view.kind === 'loading' && <Spinner testID="favourites.loading" />}
        {view.kind === 'failed' && (
          <VStack space="xs" className="items-center">
            <Text testID="favourites.loadFailed" className="text-center text-muted-foreground">
              Couldn't load your favourite questions.
            </Text>
            <Pressable
              testID="favourites.retry"
              disabled={!reachable}
              onPress={() => { void refresh(); }}
              className={reachable ? '' : 'opacity-40'}
            >
              <Text className="text-primary">Try again</Text>
            </Pressable>
          </VStack>
        )}
        {view.kind === 'empty' && (
          <>
            <Text className="text-center text-muted-foreground">
              Start a conversation, or keep a question you ask often here.
            </Text>
            {addButton}
          </>
        )}
        {view.kind === 'list' && (
          <>
            <Text className="text-center text-muted-foreground">
              Start a conversation, or ask one of your favourites:
            </Text>
            <HStack space="sm" style={{ flexWrap: 'wrap', justifyContent: 'center' }}>
              {view.questions.map((q) => (
                <HStack
                  key={q.id}
                  className="items-start rounded-md border border-border bg-card"
                  style={{ width }}
                >
                  <Pressable
                    testID={`favourites.question.${q.id}`}
                    accessibilityLabel={q.text}
                    disabled={!reachable}
                    onPress={() => { onPick(q.text); }}
                    className={`min-w-0 flex-1 p-4 web:hover:bg-muted/30 ${reachable ? '' : 'opacity-40'}`}
                  >
                    <Text testID={`favourites.label.${q.id}`} className="font-semibold text-card-foreground">
                      {q.text}
                    </Text>
                  </Pressable>
                  <Pressable
                    testID={`favourites.remove.${q.id}`}
                    accessibilityLabel={`Remove favourite: ${q.text}`}
                    disabled={!reachable}
                    onPress={() => { void remove(q); }}
                    className={`shrink-0 p-3 web:hover:bg-muted/30 ${reachable ? '' : 'opacity-40'}`}
                  >
                    <Icon as={X} size="sm" className="text-muted-foreground" />
                  </Pressable>
                </HStack>
              ))}
              {view.canAdd && addButton}
            </HStack>
          </>
        )}
      </VStack>
      <AddFavouriteModal
        open={adding}
        onClose={() => { setAdding(false); }}
        onSave={add}
        existing={view.kind === 'list' ? view.questions : []}
      />
    </Box>
  );
}
