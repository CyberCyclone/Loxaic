import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  getContextStage,
  requestContextStage,
  withdrawContextStage,
  type ContextStageInfo,
  type ModelInfo,
} from '@loxaic/api-client';
import type { ContextView } from '@/hooks/useContextUsage';
import { useToastHelper } from '@/hooks/useToastHelper';
import {
  formatWindow,
  mayChangeStage,
  needsCompactFirst,
  nextStage,
  shouldPromptApproaching,
  shouldPromptStepDown,
  approachingKey,
  stepDownKey,
  stepDownTarget,
} from '@/lib/contextStages';
import { isServerConvId } from '@/lib/streamMessages';
import type { StageCard } from '@/lib/stageCard';
import { isStageActive } from '@/lib/stageCard';

/**
 * Everything the screens need to let someone change a host model's context
 * stage: when to ask (the approaching-the-limit and step-down modals), the
 * Context settings sheet, the choice made before a chat exists, and the
 * requests themselves. The decisions are lib/contextStages.ts; this is the
 * state around them.
 *
 * A stage is model-wide, so a request moves the model for everyone on it — the
 * dialogs say so (they are filled from the server's `others`), and the request
 * waits behind any reply in progress. What the person sees while it happens is
 * the stage card, not anything here.
 */

export type StageDialog =
  | { kind: 'approaching' }
  | { kind: 'stepdown' }
  | { kind: 'settings' }
  | { kind: 'compactFirst'; target: number };

export interface StageControls {
  /** "512K · YaRN 2×" — where the model is now. */
  label: string;
  mayChange: boolean;
  /** Why not, when the person may not change it. */
  reason: string | null;
  canExtend: boolean;
  canSwitchBack: boolean;
  /** "Switching to 512K after the current reply…", or null. */
  pendingLabel: string | null;
  busy: boolean;
  onExtend: () => void;
  onSwitchBack: () => void;
  onOpenSettings: () => void;
  onCancelPending: () => void;
}

interface Args {
  token: string | null;
  /** The model this conversation is on. */
  model: string | undefined;
  models: ModelInfo[];
  /** The open thread's id — a server id, or a placeholder before its first send. */
  conversationId: string | null;
  context: ContextView | null;
  streaming: boolean;
  /** Offline, a viewer, or a routine: nobody who can act on this thread. */
  readOnly: boolean;
  isAdmin: boolean;
  /** Run /compact on this conversation now. */
  onCompact: () => void;
  refreshModels: () => void;
  stageCard: StageCard | null;
  /** The placeholder → real id swap of a conversation this session created. */
  promotion: { localId: string; realId: string } | null;
}

const POLL_PENDING_MS = 4000;

export function useContextStages(a: Args) {
  const { showToast } = useToastHelper();
  const modelInfo = a.models.find((m) => m.id === a.model);
  const stage = modelInfo?.context_stage;
  const serverConvId = a.conversationId && isServerConvId(a.conversationId) ? a.conversationId : null;
  const mayChange = stage ? mayChangeStage(stage, a.isAdmin) : false;

  const [dialog, setDialog] = useState<StageDialog | null>(null);
  const [info, setInfo] = useState<ContextStageInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  // A choice made before the conversation exists, keyed to the model it was
  // made for: it rides the send that opens the conversation.
  const [choice, setChoice] = useState<{ model: string; stage: number } | null>(null);
  const shown = useRef(new Set<string>());
  const infoSeq = useRef(0);

  // What the send that creates a conversation carries — read at send time.
  const pendingStage = choice && choice.model === a.model && !serverConvId ? choice.stage : undefined;
  const pendingStageRef = useRef<number | undefined>(undefined);
  pendingStageRef.current = pendingStage;
  // Once the conversation exists the choice has been spent.
  useEffect(() => {
    if (serverConvId && choice) setChoice(null);
  }, [serverConvId, choice]);

  const loadInfo = useCallback(async (): Promise<ContextStageInfo | null> => {
    if (!a.model) return null;
    const seq = ++infoSeq.current;
    try {
      const fresh = await getContextStage(a.model, serverConvId);
      if (seq === infoSeq.current) {
        setInfo(fresh);
        setInfoError(null);
      }
      return fresh;
    } catch (err) {
      if (seq === infoSeq.current) setInfoError(err instanceof Error ? err.message : 'Could not read the context stages');
      return null;
    }
  }, [a.model, serverConvId]);

  const open = useCallback(
    (next: StageDialog) => {
      setInfo(null);
      setInfoError(null);
      setDialog(next);
      void loadInfo();
    },
    [loadInfo],
  );
  const close = useCallback(() => {
    infoSeq.current++;
    setDialog(null);
  }, []);

  // The model list is fetched when a stream ends, so right after this device
  // watched a switch apply it can still describe the stage before. Nothing is
  // asked from a list that disagrees with a switch just seen finishing: an
  // offer to extend "to the next stage" would be measured against the old one.
  const listBehind =
    a.stageCard?.status.step === 'applied' && stage !== undefined && stage.active !== a.stageCard.status.to_stage;

  // ── Approaching the limit: after a turn ends ────────────────────────────
  const anyDialog = dialog !== null;
  useEffect(() => {
    if (anyDialog || !stage || !serverConvId || listBehind) return;
    if (
      shouldPromptApproaching({
        stage,
        usedTokens: a.context?.used ?? 0,
        streaming: a.streaming || isStageActive(a.stageCard),
        readOnly: a.readOnly,
        shown: shown.current,
        conversationId: serverConvId,
      })
    ) {
      shown.current.add(approachingKey(serverConvId, stage.active));
      open({ kind: 'approaching' });
    }
  }, [anyDialog, stage, serverConvId, a.context?.used, a.streaming, a.stageCard, a.readOnly, listBehind, open]);

  // ── Stepping down: on *reopening* a conversation that needs less ────────
  // Not for one this session has just been in: a chat started at 64K on
  // purpose needs little, and being asked to switch back the moment it starts
  // would undo the choice. The id is remembered while a reply streams — under
  // its placeholder and again under its real one, which the switch between the
  // two happens during.
  const inThisSession = useRef(new Set<string>());
  useEffect(() => {
    if ((a.streaming || isStageActive(a.stageCard)) && a.conversationId) inThisSession.current.add(a.conversationId);
  }, [a.streaming, a.stageCard, a.conversationId]);
  // The swap is what says a conversation began here: read it directly rather
  // than infer it from a stream that may not be flagged at the right render.
  useEffect(() => {
    if (a.promotion) inThisSession.current.add(a.promotion.realId);
  }, [a.promotion]);
  // A step-down offer the model no longer needs (it was switched meanwhile,
  // here or by someone else) must not stay up describing a stage it left.
  useEffect(() => {
    if (dialog?.kind === 'stepdown' && (!stage || stage.active === 0)) setDialog(null);
    // Likewise "nearly full — extend" once there is nothing larger to extend to.
    if (dialog?.kind === 'approaching' && stage && nextStage(stage) === null) setDialog(null);
  }, [dialog, stage]);
  const checkedDown = useRef(new Set<string>());
  useEffect(() => {
    if (anyDialog || !stage || !serverConvId || !a.model || stage.active === 0 || a.readOnly || a.streaming || listBehind) return;
    if (!mayChange) return;
    const key = stepDownKey(serverConvId, stage.active);
    if (checkedDown.current.has(key) || shown.current.has(key) || inThisSession.current.has(serverConvId)) return;
    checkedDown.current.add(key);
    const model = a.model;
    void getContextStage(model, serverConvId)
      .then((fresh) => {
        if (!shouldPromptStepDown({ stage, info: fresh, conversationId: serverConvId, readOnly: a.readOnly, shown: shown.current })) return;
        shown.current.add(key);
        setInfo(fresh);
        setInfoError(null);
        setDialog({ kind: 'stepdown' });
      })
      .catch(() => undefined);
  }, [anyDialog, stage, serverConvId, a.model, a.readOnly, a.streaming, mayChange, listBehind]);

  // A switch other people are waiting on: keep the popup honest.
  // Also while this device's own switch is running: the request returns before
  // the server has recorded the switch as pending, so the list fetched right
  // after it can miss it, and nothing would ask again.
  const pending = stage?.pending ?? null;
  const refresh = a.refreshModels;
  const switching = pending !== null || isStageActive(a.stageCard);
  useEffect(() => {
    if (!switching) return;
    const id = setInterval(refresh, POLL_PENDING_MS);
    return () => { clearInterval(id); };
  }, [switching, refresh]);

  // ── Requests ────────────────────────────────────────────────────────────
  const request = useCallback(
    async (target: number, compactFirst = false): Promise<boolean> => {
      if (!a.model) return false;
      setRequesting(true);
      try {
        await requestContextStage({ model: a.model, stage: target, conversationId: serverConvId, compactFirst });
        a.refreshModels();
        return true;
      } catch (err) {
        showToast(err instanceof ApiError || err instanceof Error ? err.message : 'Could not change the context', 6000);
        return false;
      } finally {
        setRequesting(false);
      }
    },
    [a, serverConvId, showToast],
  );

  const extend = useCallback(async () => {
    if (!stage) return;
    const next = nextStage(stage);
    if (next === null) return;
    if (await request(next)) close();
  }, [stage, request, close]);

  const compact = useCallback(() => {
    close();
    a.onCompact();
  }, [a, close]);

  const stepDown = useCallback(async () => {
    if (!info) return;
    if (await request(stepDownTarget(info))) close();
  }, [info, request, close]);

  /** Context settings: choose a stage by index. */
  const choose = useCallback(
    async (target: number) => {
      if (!stage || !a.model) return;
      if (!serverConvId) {
        // Before the chat exists: remembered for the first send.
        setChoice({ model: a.model, stage: target });
        close();
        return;
      }
      if (target === stage.active && stage.pending === null) {
        close();
        return;
      }
      const targetWindow = stage.windows[target] as number | null | undefined;
      if (target < stage.active && needsCompactFirst(a.context?.used ?? null, targetWindow ?? null)) {
        setDialog({ kind: 'compactFirst', target });
        return;
      }
      if (await request(target)) close();
    },
    [stage, a.model, a.context?.used, serverConvId, request, close],
  );

  const confirmCompactFirst = useCallback(async () => {
    if (dialog?.kind !== 'compactFirst') return;
    if (await request(dialog.target, true)) close();
  }, [dialog, request, close]);

  const cancelPending = useCallback(async () => {
    if (!a.model) return;
    try {
      await withdrawContextStage(a.model);
      a.refreshModels();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not cancel the switch', 5000);
    }
  }, [a, showToast]);

  const controls: StageControls | null = useMemo(() => {
    if (!stage) return null;
    const next = nextStage(stage);
    const windows = stage.windows;
    return {
      label: `${formatWindow(windows[stage.active])}${stage.active === 0 ? ' · standard' : ''}`,
      mayChange,
      reason: mayChange ? null : "An admin controls this model's context.",
      canExtend: mayChange && next !== null && !!serverConvId,
      canSwitchBack: mayChange && stage.active > 0 && !!serverConvId,
      // The model list knows another person's pending switch; this device's own
      // is known at once from its card, before the list has caught up.
      pendingLabel:
        stage.pending !== null
          ? `Switching to ${formatWindow(windows[stage.pending])} after the current reply…`
          : a.stageCard?.status.step === 'waiting'
            ? `Switching to ${formatWindow(a.stageCard.status.to_tokens)} after the current reply…`
            : null,
      busy: requesting || a.streaming,
      onExtend: () => { open({ kind: 'approaching' }); },
      onSwitchBack: () => { void choose(stage.active - 1); },
      onOpenSettings: () => { open({ kind: 'settings' }); },
      onCancelPending: () => { void cancelPending(); },
    };
  }, [stage, mayChange, serverConvId, requesting, a.streaming, a.stageCard, open, choose, cancelPending]);

  return {
    /** The model has YaRN stages. */
    staged: stage !== undefined,
    stage,
    mayChange,
    dialog,
    info,
    infoError,
    requesting,
    open,
    close,
    extend,
    compact,
    stepDown,
    choose,
    confirmCompactFirst,
    cancelPending,
    controls,
    /** For the send that creates the conversation. */
    pendingStageRef,
    /** The stage chosen before the chat exists, for the chip. */
    pendingStage,
    clearChoice: () => { setChoice(null); },
    serverConvId,
    usedTokens: a.context?.used ?? 0,
    modelInfo,
  };
}

export type ContextStagesState = ReturnType<typeof useContextStages>;
