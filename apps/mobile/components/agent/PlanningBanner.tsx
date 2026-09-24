import { Compass } from 'lucide-react-native';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';

export function PlanningBanner() {
  return (
    <HStack testID="agent.planning.banner" space="xs" className="items-center border-t border-warning/30 bg-warning/10 px-4 py-2">
      <Icon as={Compass} size="xs" className="text-warning" />
      <Text size="xs" className="flex-1 text-warning">
        Planning mode — writes are blocked. The agent will produce a plan for your review.
      </Text>
    </HStack>
  );
}
