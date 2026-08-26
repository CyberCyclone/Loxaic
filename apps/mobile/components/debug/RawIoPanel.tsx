import { useEffect, useRef, useState } from 'react'
import { Platform, ScrollView } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { ChevronRight, Copy, Eraser, X } from 'lucide-react-native'
import {
  Actionsheet,
  ActionsheetBackdrop,
  ActionsheetContent,
  ActionsheetDragIndicator,
  ActionsheetDragIndicatorWrapper,
} from '@/components/ui/actionsheet'
import { Box } from '@/components/ui/box'
import { HStack } from '@/components/ui/hstack'
import { VStack } from '@/components/ui/vstack'
import { Text } from '@/components/ui/text'
import { Pressable } from '@/components/ui/pressable'
import { Icon } from '@/components/ui/icon'
import { useToastHelper } from '@/hooks/useToastHelper'
import { debugBody, describeChannel, isTruncated, type DebugEntry } from '@/lib/debug-ring'

const CHANNEL_TINT: Record<string, string> = {
  'model.request': 'text-primary bg-primary/15',
  'model.raw': 'text-muted-foreground bg-muted',
  'model.done': 'text-success bg-success/15',
  'tool.call': 'text-warning bg-warning/15',
  'tool.result_raw': 'text-warning bg-warning/15',
  'mcp.lifecycle': 'text-destructive bg-destructive/15',
}

function timeOf(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

/** A request body carrying every tool schema runs to tens of thousands of
 * characters; rendering that inline produces an 80,000px-tall text node that
 * no nested scroll view constrains on web. The row previews the head and
 * Copy still yields the whole thing. */
const PREVIEW_CHARS = 4000

function DebugRow({ entry }: { entry: DebugEntry }) {
  const [open, setOpen] = useState(false)
  const { showToast } = useToastHelper()
  const body = debugBody(entry.event)
  const preview = body.length > PREVIEW_CHARS ? `${body.slice(0, PREVIEW_CHARS)}\n…` : body
  const tint = CHANNEL_TINT[entry.event.channel] ?? 'text-muted-foreground bg-muted'

  return (
    <Box className="border-b border-border">
      <Pressable onPress={() => setOpen((o) => !o)}>
        <HStack className="items-center gap-2 px-3 py-2">
          <Icon
            as={ChevronRight}
            size="xs"
            className="text-muted-foreground"
            style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}
          />
          <Text size="2xs" className={`rounded-sm px-1.5 py-0.5 ${tint}`}>
            {entry.event.channel}
          </Text>
          <Text size="xs" className="flex-1 text-card-foreground" numberOfLines={1}>
            {describeChannel(entry.event)}
          </Text>
          {isTruncated(entry.event) && (
            <Text size="2xs" className="text-warning">
              truncated
            </Text>
          )}
          <Text size="2xs" className="text-muted-foreground">
            {timeOf(entry.ts)}
          </Text>
        </HStack>
      </Pressable>

      {open && (
        <Box className="bg-background">
          <ScrollView style={{ maxHeight: 220 }}>
            <Text
              // Leading must come from a class: a numeric inline lineHeight is
              // unitless on web (Text renders as a span), so `16` would mean
              // 16× the font size.
              className="p-3 leading-[16px] text-muted-foreground"
              style={{
                fontFamily: 'monospace',
                fontSize: 11,
                // Raw JSON is one long unbreakable "word" — native Text breaks
                // it at the container edge, the web renderer needs telling.
                ...Platform.select({ web: { wordBreak: 'break-all' as const }, default: {} }),
              }}
            >
              {preview}
            </Text>
          </ScrollView>
          <HStack className="items-center justify-end gap-3 px-3 pb-2">
            {preview !== body && (
              <Text size="2xs" className="flex-1 text-muted-foreground">
                Showing first {PREVIEW_CHARS.toLocaleString()} of {body.length.toLocaleString()} chars
              </Text>
            )}
            <Pressable
              onPress={async () => {
                await Clipboard.setStringAsync(body)
                showToast('Copied')
              }}
              className="flex-row items-center gap-1 p-1"
            >
              <Icon as={Copy} size="xs" className="text-muted-foreground" />
              <Text size="2xs" className="text-muted-foreground">
                Copy
              </Text>
            </Pressable>
          </HStack>
        </Box>
      )}
    </Box>
  )
}

function PanelBody({
  entries,
  onClear,
  onClose,
}: {
  entries: DebugEntry[]
  onClear: () => void
  onClose: () => void
}) {
  const scrollRef = useRef<ScrollView>(null)
  const followRef = useRef(true)

  useEffect(() => {
    if (followRef.current) scrollRef.current?.scrollToEnd({ animated: false })
  }, [entries.length])

  return (
    <VStack className="h-full w-full">
      <HStack className="items-center justify-between border-b border-border px-3 py-3">
        <VStack>
          <Text size="sm" className="font-semibold text-foreground">
            Raw I/O
          </Text>
          <Text size="2xs" className="text-muted-foreground">
            {entries.length === 0 ? 'Capturing while this panel is open' : `${entries.length} events · live only`}
          </Text>
        </VStack>
        <HStack space="sm" className="items-center">
          <Pressable onPress={onClear} className="flex-row items-center gap-1 rounded-sm p-1.5 web:hover:bg-muted/50">
            <Icon as={Eraser} size="xs" className="text-muted-foreground" />
            <Text size="2xs" className="text-muted-foreground">
              Clear
            </Text>
          </Pressable>
          <Pressable onPress={onClose} className="rounded-sm p-1.5 web:hover:bg-muted/50">
            <Icon as={X} size="sm" className="text-muted-foreground" />
          </Pressable>
        </HStack>
      </HStack>

      {entries.length === 0 ? (
        <Box className="flex-1 items-center justify-center p-6">
          <Text size="sm" className="text-center text-muted-foreground">
            Nothing captured yet. Send a message and the exact request, the raw response stream, and every tool call
            will appear here.
          </Text>
        </Box>
      ) : (
        <ScrollView
          ref={scrollRef}
          onScroll={(e) => {
            const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent
            followRef.current = layoutMeasurement.height + contentOffset.y >= contentSize.height - 40
          }}
          scrollEventThrottle={100}
          style={{ flex: 1 }}
        >
          {entries.map((entry) => (
            <DebugRow key={entry.id} entry={entry} />
          ))}
        </ScrollView>
      )}
    </VStack>
  )
}

interface RawIoPanelProps {
  open: boolean
  onClose: () => void
  wide: boolean
  entries: DebugEntry[]
  onClear: () => void
}

/** Dev-mode telemetry viewer. Content is live-only by design — the server
 * buffers nothing, so closing the panel or reloading starts a fresh capture. */
export function RawIoPanel({ open, onClose, wide, entries, onClear }: RawIoPanelProps) {
  if (!open) return null

  // Wide: a side panel, not an overlay — the whole point is watching traffic
  // while you keep sending messages, which a modal over the composer prevents.
  if (wide) {
    return (
      <Box className="h-full w-[380px] border-l border-border bg-background">
        <PanelBody entries={entries} onClear={onClear} onClose={onClose} />
      </Box>
    )
  }

  return (
    <Actionsheet isOpen={open} onClose={onClose}>
      <ActionsheetBackdrop />
      <ActionsheetContent className="h-[80%]">
        <ActionsheetDragIndicatorWrapper>
          <ActionsheetDragIndicator />
        </ActionsheetDragIndicatorWrapper>
        <PanelBody entries={entries} onClear={onClear} onClose={onClose} />
      </ActionsheetContent>
    </Actionsheet>
  )
}
