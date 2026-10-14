import { useState } from 'react';
import { ScrollView } from 'react-native';
import { Plus } from 'lucide-react-native';
import type { BuiltinSkillView, SkillInput, UserSkill } from '@loxaic/api-client';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Heading } from '@/components/ui/heading';
import { Pressable } from '@/components/ui/pressable';
import { Button, ButtonText, ButtonIcon } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { MainHeader } from '@/components/shell/MainHeader';
import { useShell } from '@/components/shell/AppShell';
import { SkillModal } from '@/components/skills/SkillModal';
import { SkillViewModal } from '@/components/skills/SkillViewModal';
import { WarningConfirmModal } from '@/components/sandbox/WarningConfirmModal';
import { useMySkills } from '@/hooks/useMySkills';
import { useServerReachable } from '@/lib/connection';
import { useSession } from '@/lib/session';
import { clampLines } from '@/lib/truncate';
import { deleteSkillMessage } from '@/lib/skillScreen';

const CLAMP = clampLines(2);

/**
 * Skills (#283): the person's own, which they add, edit and delete, and the
 * built-ins, which they can read and override but never change. Overriding
 * is adding a skill of the same name; both rows say so while it lasts.
 */
export default function SkillsScreen() {
  const shell = useShell();
  const { token } = useSession();
  const reachable = useServerReachable();
  const { data, loadFailed, refresh, save, remove } = useMySkills(token);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<UserSkill | null>(null);
  const [prefill, setPrefill] = useState<Pick<SkillInput, 'name' | 'description' | 'body'> | null>(null);
  const [viewing, setViewing] = useState<BuiltinSkillView | null>(null);
  const [deleting, setDeleting] = useState<UserSkill | null>(null);

  const openCreate = (from: BuiltinSkillView | null = null) => {
    setEditing(null);
    setPrefill(from ? { name: from.name, description: from.description, body: from.body } : null);
    setModalOpen(true);
  };
  const openEdit = (skill: UserSkill) => {
    setEditing(skill);
    setPrefill(null);
    setModalOpen(true);
  };

  const mine = data?.mine ?? [];
  const builtin = data?.builtin ?? [];

  return (
    <VStack className="h-full flex-1">
      <MainHeader
        title="Skills"
        onOpenMenu={shell.overlaySidebar ? shell.openSidebar : undefined}
        right={
          <Button testID="skills.add" size="sm" className="bg-primary" onPress={() => { openCreate(); }} isDisabled={!reachable}>
            <ButtonIcon as={Plus} className="text-primary-foreground" />
            <ButtonText className="text-primary-foreground">Add</ButtonText>
          </Button>
        }
      />

      {!data && !loadFailed ? (
        <Box className="flex-1 items-center justify-center">
          <Spinner />
        </Box>
      ) : !data ? (
        <Box className="flex-1 items-center justify-center p-6">
          <Text testID="skills.loadFailed" className="mb-3 text-center text-foreground">
            Couldn't load your skills.
          </Text>
          <Button size="sm" variant="outline" onPress={() => { void refresh(); }} isDisabled={!reachable}>
            <ButtonText>Try again</ButtonText>
          </Button>
        </Box>
      ) : (
        <ScrollView testID="skills.list" contentContainerStyle={{ padding: 12, gap: 16 }}>
          <Text size="sm" className="text-muted-foreground">
            A skill is a set of instructions for a kind of task. Type / in a message to run one; the agent can also
            load one when a task matches its description.
          </Text>

          <VStack space="sm">
            <Heading size="xs" className="text-muted-foreground">
              Your skills
            </Heading>
            {mine.length === 0 ? (
              <Text testID="skills.mine.empty" size="sm" className="text-muted-foreground">
                None yet. Add one, or override a built-in below to change how it works for you.
              </Text>
            ) : (
              mine.map((skill) => (
                <Box key={skill.id} testID={`skills.row.${skill.id}`} className="rounded-md border border-border bg-card p-3">
                  <VStack space="xs">
                    <HStack space="sm" className="flex-wrap items-center">
                      <Text testID={`skills.row.${skill.id}.name`} className="font-medium text-foreground">
                        /{skill.name}
                      </Text>
                      {skill.overridesBuiltin && (
                        <Text testID={`skills.row.${skill.id}.overrides`} size="2xs" className="rounded-sm bg-primary/15 px-1.5 py-0.5 text-primary">
                          Overrides built-in
                        </Text>
                      )}
                      {!skill.modelInvocable && (
                        <Text size="2xs" className="rounded-sm bg-muted px-1.5 py-0.5 text-muted-foreground">
                          Only when you type it
                        </Text>
                      )}
                    </HStack>
                    <Text size="sm" className="text-muted-foreground" numberOfLines={2} style={CLAMP}>
                      {skill.description}
                    </Text>
                    <HStack space="sm" className="pt-1">
                      <Button testID={`skills.row.${skill.id}.edit`} size="sm" variant="outline" onPress={() => { openEdit(skill); }} isDisabled={!reachable}>
                        <ButtonText>Edit</ButtonText>
                      </Button>
                      <Button testID={`skills.row.${skill.id}.delete`} size="sm" variant="outline" onPress={() => { setDeleting(skill); }} isDisabled={!reachable}>
                        <ButtonText className="text-destructive">Delete</ButtonText>
                      </Button>
                    </HStack>
                  </VStack>
                </Box>
              ))
            )}
          </VStack>

          <VStack space="sm">
            <Heading size="xs" className="text-muted-foreground">
              Built-in
            </Heading>
            {builtin.map((skill) => {
              const override = skill.overriddenBy ? mine.find((m) => m.id === skill.overriddenBy) ?? null : null;
              return (
                <Box key={skill.name} testID={`skills.builtin.${skill.name}`} className="rounded-md border border-border bg-card p-3">
                  <VStack space="xs">
                    <HStack space="sm" className="flex-wrap items-center">
                      <Text className={`font-medium ${override ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                        /{skill.name}
                      </Text>
                      {override && (
                        <Text testID={`skills.builtin.${skill.name}.overridden`} size="2xs" className="rounded-sm bg-muted px-1.5 py-0.5 text-muted-foreground">
                          Overridden by your skill
                        </Text>
                      )}
                    </HStack>
                    <Text size="sm" className="text-muted-foreground" numberOfLines={2} style={CLAMP}>
                      {skill.description}
                    </Text>
                    <HStack space="sm" className="pt-1">
                      <Button testID={`skills.builtin.${skill.name}.view`} size="sm" variant="outline" onPress={() => { setViewing(skill); }}>
                        <ButtonText>View</ButtonText>
                      </Button>
                      <Button
                        testID={`skills.builtin.${skill.name}.override`}
                        size="sm"
                        variant="outline"
                        onPress={() => { if (override) openEdit(override); else openCreate(skill); }}
                        isDisabled={!reachable}
                      >
                        <ButtonText>{override ? 'Edit your override' : 'Override'}</ButtonText>
                      </Button>
                    </HStack>
                  </VStack>
                </Box>
              );
            })}
          </VStack>
          <Pressable onPress={() => { void refresh(); }} className="self-center px-2 py-1">
            <Text size="2xs" className="text-muted-foreground">
              Refresh
            </Text>
          </Pressable>
        </ScrollView>
      )}

      <SkillModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); }}
        onSave={(input) => save(input, editing)}
        editing={editing}
        prefill={prefill}
        builtinNames={builtin.map((b) => b.name)}
      />
      <SkillViewModal skill={viewing} onClose={() => { setViewing(null); }} />
      <WarningConfirmModal
        open={deleting !== null}
        title="Delete skill?"
        message={deleting ? deleteSkillMessage(deleting) : ''}
        confirmLabel="Delete skill"
        testIDPrefix="skills.deleteConfirm"
        onConfirm={() => {
          const target = deleting;
          setDeleting(null);
          if (target) void remove(target);
        }}
        onCancel={() => { setDeleting(null); }}
      />
    </VStack>
  );
}
