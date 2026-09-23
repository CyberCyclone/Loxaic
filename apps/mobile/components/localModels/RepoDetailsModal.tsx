import { useEffect, useRef, useState } from 'react';
import { Download, Eye, Heart, Lock } from 'lucide-react-native';
import { getHfRepoDetails, type HfQuant, type HfRepoDetails } from '@loxaic/api-client';
import {
  Modal,
  ModalBackdrop,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalHeader,
} from '@/components/ui/modal';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Heading } from '@/components/ui/heading';
import { Pressable } from '@/components/ui/pressable';
import { Icon, CloseIcon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { Markdown } from '@/components/markdown/Markdown';
import { FitBadge } from './FitBadge';
import { formatBytes, formatCount, formatParams } from '@/lib/localModels';
import { TRUNCATE_TEXT } from '@/lib/truncate';

interface RepoDetailsModalProps {
  repo: string | null;
  onClose: () => void;
  onDownload: (input: { repo: string; quant: string; mmproj: string | null; force?: boolean }) => Promise<unknown>;
}

/**
 * One HuggingFace repository: who published it, its stats, its description
 * (the model card), and every quant with its size and fit label.
 *
 * The card is untrusted markdown from a stranger's repository. It renders
 * through the same component as a model's reply, which shows HTML as literal
 * text and images as a link rather than fetching them.
 */
export function RepoDetailsModal({ repo, onClose, onDownload }: RepoDetailsModalProps) {
  const [details, setDetails] = useState<HfRepoDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [withVision, setWithVision] = useState(true);
  const [confirm, setConfirm] = useState<HfQuant | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  // Opening repo A, closing it and opening B must never show A's quants under
  // B's name — downloading from that list would fetch the wrong model.
  const request = useRef(0);

  useEffect(() => {
    const mine = ++request.current;
    setDetails(null);
    setError(null);
    if (!repo) return;
    getHfRepoDetails(repo)
      .then((d) => {
        if (mine !== request.current) return;
        setDetails(d);
        setWithVision(d.summary.vision);
      })
      .catch((err: unknown) => {
        if (mine !== request.current) return;
        setError(err instanceof Error ? err.message : 'Could not load this model');
      });
  }, [repo]);

  const mmproj = details?.files.mmproj.find((m) => /f16/i.test(m.path)) ?? details?.files.mmproj[0] ?? null;

  const start = async (quant: HfQuant, force = false) => {
    if (!details) return;
    setStarting(quant.quant);
    try {
      await onDownload({ repo: details.summary.repo, quant: quant.quant, mmproj: withVision && mmproj ? mmproj.path : null, force });
    } finally {
      setStarting(null);
    }
  };

  const s = details?.summary;
  const params = formatParams(s?.params);

  return (
    <Modal isOpen={repo !== null} onClose={onClose} size="lg">
      <ModalBackdrop />
      {/* Both halves: a long model card and a long quant list are exactly what
          pushes content past the fold, and the vendored ModalBody hardcodes
          scrollEnabled={false} before its prop spread. */}
      <ModalContent testID="localModels.details" className="max-h-[85%]">
        <ModalHeader>
          <VStack className="min-w-0 flex-1 shrink pr-2">
            <Heading size="sm" numberOfLines={1} style={TRUNCATE_TEXT}>
              {s?.name ?? repo ?? ''}
            </Heading>
            <Text testID="localModels.details.publisher" size="xs" className="text-muted-foreground">
              by {s?.publisher ?? repo?.split('/')[0] ?? ''}
            </Text>
          </VStack>
          <ModalCloseButton testID="localModels.details.close">
            <Icon as={CloseIcon} />
          </ModalCloseButton>
        </ModalHeader>
        <ModalBody scrollEnabled>
          {!details && !error && (
            <Box className="items-center py-8">
              <Spinner />
            </Box>
          )}
          {error && (
            <Text size="sm" className="text-destructive">
              {error}
            </Text>
          )}
          {details && s && (
            <VStack space="lg">
              <HStack testID="localModels.details.stats" space="md" className="flex-wrap items-center">
                <HStack space="xs" className="items-center">
                  <Icon as={Download} size="2xs" className="text-muted-foreground" />
                  <Text size="xs" className="text-muted-foreground">
                    {formatCount(s.downloads)} this month
                    {s.downloadsAllTime ? ` · ${formatCount(s.downloadsAllTime)} all time` : ''}
                  </Text>
                </HStack>
                <HStack space="xs" className="items-center">
                  <Icon as={Heart} size="2xs" className="text-muted-foreground" />
                  <Text size="xs" className="text-muted-foreground">
                    {formatCount(s.likes)}
                  </Text>
                </HStack>
                {params && (
                  <Text size="xs" className="text-muted-foreground">
                    {params}
                  </Text>
                )}
                {s.architecture && (
                  <Text size="xs" className="text-muted-foreground">
                    {s.architecture}
                  </Text>
                )}
                {s.contextLength && (
                  <Text size="xs" className="text-muted-foreground">
                    {formatCount(s.contextLength)} context
                  </Text>
                )}
                {s.license && (
                  <Text size="xs" className="text-muted-foreground">
                    {s.license}
                  </Text>
                )}
                {details.baseModel && (
                  // `min-w-0 shrink` on the flex item itself, or the ellipsis
                  // never applies (see lib/truncate.ts): the base model is an
                  // arbitrary repo id of any length.
                  <Text size="xs" className="min-w-0 max-w-full shrink text-muted-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
                    based on {details.baseModel}
                  </Text>
                )}
                {s.lastModified && (
                  <Text size="xs" className="text-muted-foreground">
                    updated {new Date(s.lastModified).toLocaleDateString()}
                  </Text>
                )}
                {s.vision && (
                  <HStack space="xs" className="items-center">
                    <Icon as={Eye} size="2xs" className="text-muted-foreground" />
                    <Text size="xs" className="text-muted-foreground">
                      reads images
                    </Text>
                  </HStack>
                )}
              </HStack>

              {s.gated && (
                <HStack space="xs" className="items-start rounded-md bg-warning/15 p-2">
                  <Icon as={Lock} size="xs" className="mt-0.5 text-warning" />
                  <Text size="xs" className="min-w-0 flex-1 text-foreground">
                    This model is gated. Accept its terms on huggingface.co, and add a HuggingFace token under Runtime
                    settings, before downloading.
                  </Text>
                </HStack>
              )}

              <VStack space="xs">
                <Text size="sm" className="font-medium text-foreground">
                  Choose a quant
                </Text>
                <Text size="2xs" className="text-muted-foreground">
                  Smaller quants are faster and fit in less memory; larger ones are closer to the original model.
                  Q4_K_M is the usual choice.
                </Text>
                {mmproj && (
                  <Pressable
                    testID="localModels.details.vision"
                    onPress={() => { setWithVision((v) => !v); }}
                    className={`mt-1 self-start rounded-full px-3 py-1.5 ${withVision ? 'bg-primary/15' : 'bg-muted'}`}
                  >
                    <Text size="sm" className={withVision ? 'text-primary' : 'text-muted-foreground'}>
                      {withVision ? '✓ ' : ''}Include vision ({formatBytes(mmproj.size)})
                    </Text>
                  </Pressable>
                )}
                {details.files.quants.length === 0 && (
                  <Text size="sm" className="text-muted-foreground">
                    This repository has no GGUF file llama.cpp can load.
                  </Text>
                )}
                {confirm && (
                  // Inline rather than a second dialog: nothing in this app
                  // stacks modals, and the quant list is what the decision is
                  // about, so it stays in view.
                  <VStack testID="localModels.wontFit" space="xs" className="rounded-md bg-destructive/10 p-3">
                    <Text size="sm" className="font-medium text-foreground">
                      {confirm.quant} probably won&apos;t fit
                    </Text>
                    <Text size="xs" className="text-foreground">
                      It needs about {formatBytes(confirm.fit.requiredBytes)}, and{' '}
                      {formatBytes(confirm.fit.availableBytes)} is available. It may fail to load, or run mostly on the
                      CPU and be very slow. Pick a smaller quant unless you mean to give it a shorter context or fewer
                      GPU layers in its settings.
                    </Text>
                    <HStack space="sm" className="justify-end">
                      <Pressable testID="localModels.wontFit.cancel" onPress={() => { setConfirm(null); }} className="px-3 py-1.5">
                        <Text size="sm" className="text-muted-foreground">
                          Cancel
                        </Text>
                      </Pressable>
                      <Pressable
                        testID="localModels.wontFit.confirm"
                        onPress={() => {
                          const q = confirm;
                          setConfirm(null);
                          void start(q, true);
                        }}
                        className="rounded-md bg-destructive px-3 py-1.5"
                      >
                        <Text size="sm" className="text-destructive-foreground">
                          Download anyway
                        </Text>
                      </Pressable>
                    </HStack>
                  </VStack>
                )}
                {details.files.quants.map((q) => (
                  <HStack
                    key={q.quant}
                    testID={`localModels.quant.${q.quant}`}
                    className="items-center justify-between rounded-md border border-border px-3 py-2"
                  >
                    <VStack className="min-w-0 shrink pr-2">
                      <Text size="sm" className="text-foreground" numberOfLines={1} style={TRUNCATE_TEXT}>
                        {q.quant}
                      </Text>
                      <Text size="2xs" className="text-muted-foreground">
                        {formatBytes(q.sizeBytes)}
                        {q.files.length > 1 ? ` · ${String(q.files.length)} files` : ''}
                      </Text>
                    </VStack>
                    <HStack space="sm" className="shrink-0 items-center">
                      <FitBadge label={q.fit.label} testID={`localModels.quant.fit.${q.quant}`} />
                      {q.downloadStatus ? (
                        <Text size="xs" className="text-muted-foreground">
                          {q.downloadStatus === 'ready' ? 'Downloaded' : 'In the list'}
                        </Text>
                      ) : (
                        <Pressable
                          testID={`localModels.download.${q.quant}`}
                          disabled={starting !== null}
                          onPress={() => {
                            if (q.fit.label === 'wont-fit') setConfirm(q);
                            else void start(q);
                          }}
                          className="rounded-md bg-primary px-3 py-1.5"
                        >
                          {starting === q.quant ? (
                            <Spinner size="small" />
                          ) : (
                            <Text size="xs" className="text-primary-foreground">
                              Download
                            </Text>
                          )}
                        </Pressable>
                      )}
                    </HStack>
                  </HStack>
                ))}
              </VStack>

              <VStack testID="localModels.details.card" space="xs" className="border-t border-border pt-3">
                <Text size="sm" className="font-medium text-foreground">
                  About this model
                </Text>
                {details.card ? (
                  <Markdown text={details.card} size="sm" />
                ) : (
                  <Text size="sm" className="text-muted-foreground">
                    The publisher has not written a description.
                  </Text>
                )}
                {details.cardTruncated && (
                  <Text size="2xs" className="text-muted-foreground">
                    The rest of the description is on huggingface.co.
                  </Text>
                )}
              </VStack>
            </VStack>
          )}
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
