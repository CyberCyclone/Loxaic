import { useCallback, useEffect, useRef, useState, type ComponentRef, type ReactNode, type RefObject } from 'react';
import { Modal, StyleSheet } from 'react-native';
import { Brain, Check, ChevronLeft, ChevronRight, Layers, Paperclip, Plug, Plus } from 'lucide-react-native';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import {
  MENU_WIDTH,
  SUBMENU_WIDTH,
  placeMenu,
  placeSubmenu,
  type MenuPlacement,
  type Rect,
  type SubmenuPlacement,
} from '@/lib/submenuPlacement';
import type { ComposerPlusMenuProps } from './ComposerPlusMenu';
import { McpServerList } from './McpServerList';
import { levelChangeRereads, NO_THINKING_REASON, selectedThinkingOption, thinkingOptions } from '@/lib/thinking';

/** Which row's submenu is open. */
type SubKind = 'mcp' | 'thinking';

/** Long enough for the pointer to cross the gap from a row to its submenu
 * without it closing on the way. */
const HOVER_CLOSE_MS = 150;

const ACCEPT =
  'image/*,.pdf,.docx,.xlsx,.pptx,.odt,.rtf,.epub,.txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.html,.htm,.xml,.yaml,.yml,.ts,.tsx,.js,.jsx,.py,.rb,.go,.rs,.java,.c,.h,.cpp,.cs,.php,.swift,.kt,.sh,.bash,.zsh,.sql,.toml,.ini,.cfg,.conf,.env,.diff,.patch,.log,.gitignore,.gitattributes,.dockerignore,.editorconfig,.npmrc,.nvmrc,.bashrc,.zshrc,.profile';

type PressableRef = ComponentRef<typeof Pressable>;

/** Four short words and a footnote: narrower than the MCP list. */
const THINKING_WIDTH = 224;

const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
const rectOf = (el: unknown): Rect | null =>
  el && typeof (el as HTMLElement).getBoundingClientRect === 'function'
    ? (el as HTMLElement).getBoundingClientRect()
    : null;

/**
 * The composer's `+` on web and Electron: a small popup with Attach file and
 * MCP, whose submenu opens beside it on hover — a desktop context menu, not a
 * sheet. Not built on gluestack's `Menu`, which renders only flat items and
 * has no submenus.
 *
 * Attach file clicks a real, persistent `<input type="file">` rather than
 * expo-image-picker's web shim, which creates a transient hidden input at
 * click time — nothing stable for e2e to select. The input lives outside the
 * popup, mounted for the composer's lifetime, because the e2e helper writes
 * into it without opening anything; it is reset after every selection so the
 * same file can be picked twice in a row. The click happens inside the press
 * itself, so the browser still counts it as the user's gesture.
 */
export function ComposerPlusMenu({ onFilesSelected, mcp, contextSettings = null, thinking = null, disabled = false }: ComposerPlusMenuProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<PressableRef>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const mcpRowRef = useRef<PressableRef>(null);
  const thinkingRowRef = useRef<PressableRef>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [menu, setMenu] = useState<MenuPlacement | null>(null);
  const [sub, setSub] = useState<(SubmenuPlacement & { kind: SubKind }) | null>(null);

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };

  const close = useCallback(() => {
    cancelClose();
    setSub(null);
    setMenu(null);
  }, []);

  const openMenu = () => {
    const trigger = rectOf(triggerRef.current);
    if (!trigger) return;
    mcp?.refresh();
    setSub(null);
    setMenu(placeMenu(trigger, viewport()));
  };

  const openSub = (kind: SubKind) => {
    cancelClose();
    const m = rectOf(menuRef.current);
    const row = rectOf((kind === 'mcp' ? mcpRowRef : thinkingRowRef).current);
    if (m && row) setSub({ ...placeSubmenu(m, row, viewport(), kind === 'thinking' ? THINKING_WIDTH : SUBMENU_WIDTH), kind });
  };

  // A replaced menu is navigated, not hovered: leaving it must not close it.
  const scheduleCloseSub = () => {
    if (sub?.mode === 'replace') return;
    cancelClose();
    closeTimer.current = setTimeout(() => {
      setSub(null);
    }, HOVER_CLOSE_MS);
  };

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (sub) setSub(null);
        else close();
      } else if (e.key === 'ArrowLeft' && sub) {
        e.preventDefault();
        setSub(null);
      } else if (e.key === 'ArrowRight' && !sub && document.activeElement === (mcpRowRef.current as unknown)) {
        e.preventDefault();
        openSub('mcp');
      } else if (e.key === 'ArrowRight' && !sub && document.activeElement === (thinkingRowRef.current as unknown)) {
        e.preventDefault();
        openSub('thinking');
      }
    };
    // Positions are computed once, from rects that a resize invalidates.
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
    };
    // openSub reads refs only; re-binding on it would re-add on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu, sub, close]);

  useEffect(() => cancelClose, []);

  const replaced = sub?.mode === 'replace';
  const selectedLevel = thinking?.capability ? selectedThinkingOption(thinking.capability, thinking.level).level : null;

  return (
    <>
      <Pressable
        ref={triggerRef}
        testID="composer.attach"
        onPress={() => {
          if (menu) close();
          else openMenu();
        }}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        className={`shrink-0 rounded-md border border-border bg-muted p-1.5 ${disabled ? 'opacity-50' : ''}`}
      >
        <Icon as={Plus} size="2xs" className="text-foreground" />
      </Pressable>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        data-testid="composer.attach.input"
        style={{ display: 'none' }}
        disabled={disabled}
        onChange={(e) => {
          const files = e.target.files ? Array.from(e.target.files) : [];
          // Reset so selecting the same file again still fires onChange.
          e.target.value = '';
          if (files.length > 0) onFilesSelected(files);
        }}
      />
      <Modal transparent visible={menu !== null} animationType="none" onRequestClose={close}>
        <Pressable testID="composer.plus.backdrop" style={StyleSheet.absoluteFill} onPress={close} aria-label="Close menu" />
        {menu && !replaced ? (
          <Panel
            testID="composer.plus.menu"
            refObj={menuRef}
            left={menu.left}
            bottom={menu.bottom}
            width={MENU_WIDTH}
            maxHeight={menu.maxHeight}
          >
            <MenuRow
              testID="composer.plus.attach"
              icon={Paperclip}
              label="Attach file"
              onPress={() => {
                inputRef.current?.click();
                close();
              }}
              onHoverIn={() => {
                if (sub) scheduleCloseSub();
              }}
            />
            {contextSettings ? (
              <MenuRow
                testID="composer.plus.contextSettings"
                icon={Layers}
                label="Context settings"
                sublabel={contextSettings.disabledReason}
                disabled={contextSettings.disabledReason !== null}
                onPress={() => {
                  close();
                  contextSettings.onOpen();
                }}
                onHoverIn={() => {
                  if (sub) scheduleCloseSub();
                }}
              />
            ) : null}
            {thinking ? (
              <MenuRow
                testID="composer.plus.thinking"
                refObj={thinkingRowRef}
                icon={Brain}
                label="Thinking"
                value={thinking.capability ? selectedThinkingOption(thinking.capability, thinking.level).label : undefined}
                sublabel={thinking.capability ? null : NO_THINKING_REASON}
                disabled={thinking.capability === null}
                trailing={thinking.capability ? ChevronRight : undefined}
                active={sub?.kind === 'thinking'}
                onPress={() => { openSub('thinking'); }}
                onHoverIn={() => {
                  if (thinking.capability) openSub('thinking');
                  else if (sub) scheduleCloseSub();
                }}
                onHoverOut={scheduleCloseSub}
              />
            ) : null}
            {mcp ? (
              <MenuRow
                testID="composer.plus.mcp"
                refObj={mcpRowRef}
                icon={Plug}
                label="MCP"
                trailing={ChevronRight}
                active={sub?.kind === 'mcp'}
                onPress={() => { openSub('mcp'); }}
                onHoverIn={() => { openSub('mcp'); }}
                onHoverOut={scheduleCloseSub}
              />
            ) : null}
          </Panel>
        ) : null}
        {sub?.kind === 'thinking' && thinking?.capability ? (
          <Panel
            testID="composer.thinking.submenu"
            placement={sub.mode}
            left={sub.left}
            bottom={sub.bottom}
            width={THINKING_WIDTH}
            maxHeight={sub.maxHeight}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleCloseSub}
          >
            {replaced ? (
              <MenuRow
                testID="composer.thinking.back"
                icon={ChevronLeft}
                label="Thinking"
                onPress={() => {
                  setSub(null);
                }}
              />
            ) : null}
            {thinkingOptions(thinking.capability).map((option) => {
              const selected = selectedLevel === option.level;
              return (
                <MenuRow
                  key={option.level}
                  testID={`composer.thinking.level.${option.level}`}
                  checked={selected}
                  label={option.label}
                  trailing={selected ? Check : undefined}
                  onPress={() => {
                    thinking.onChange(option.level);
                    close();
                  }}
                />
              );
            })}
            {levelChangeRereads(thinking.capability) ? (
              <Text size="2xs" className="px-3 pb-1 pt-1 text-muted-foreground">
                Changing it makes the model re-read this conversation once.
              </Text>
            ) : null}
          </Panel>
        ) : null}
        {sub?.kind === 'mcp' && mcp ? (
          <Panel
            testID="composer.mcp.submenu"
            placement={sub.mode}
            left={sub.left}
            bottom={sub.bottom}
            width={SUBMENU_WIDTH}
            maxHeight={sub.maxHeight}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleCloseSub}
          >
            {replaced ? (
              <MenuRow
                testID="composer.mcp.back"
                icon={ChevronLeft}
                label="MCP"
                onPress={() => {
                  setSub(null);
                }}
              />
            ) : null}
            <McpServerList mcp={mcp} onNavigate={close} />
          </Panel>
        ) : null}
      </Modal>
    </>
  );
}

function Panel({
  testID,
  refObj,
  placement,
  left,
  bottom,
  width,
  maxHeight,
  onMouseEnter,
  onMouseLeave,
  children,
}: {
  testID: string;
  refObj?: RefObject<HTMLDivElement | null>;
  placement?: string;
  left: number;
  bottom: number;
  width: number;
  maxHeight: number;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  children: ReactNode;
}) {
  return (
    // A plain element, not an RN view: it is measured, and hover on it is
    // what keeps the submenu open while the pointer crosses into it.
    <div
      ref={refObj}
      data-testid={testID}
      role="menu"
      data-placement={placement}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="rounded-md border border-border bg-popover p-1 shadow-hard-5"
      style={{ position: 'absolute', left, bottom, width, maxWidth: 'calc(100vw - 16px)', maxHeight, overflowY: 'auto' }}
    >
      {children}
    </div>
  );
}

function MenuRow({
  testID,
  refObj,
  icon,
  label,
  value,
  trailing,
  checked,
  active = false,
  disabled = false,
  sublabel,
  onPress,
  onHoverIn,
  onHoverOut,
}: {
  testID: string;
  refObj?: RefObject<PressableRef | null>;
  icon?: typeof Plus;
  label: string;
  /** The current choice, right-aligned — "Medium" on the Thinking row. */
  value?: string;
  trailing?: typeof Plus;
  /** For a choice row: whether it is the one in force. `aria-selected`, as on
   * the agent's mode chips: react-native-web drops the `menuitemradio` role
   * and `aria-checked` through the gluestack Pressable. */
  checked?: boolean;
  active?: boolean;
  disabled?: boolean;
  /** A line under the label — why a disabled row is disabled. */
  sublabel?: string | null;
  onPress: () => void;
  onHoverIn?: () => void;
  onHoverOut?: () => void;
}) {
  return (
    <Pressable
      ref={refObj}
      testID={testID}
      role="menuitem"
      aria-selected={checked}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onPress}
      onHoverIn={onHoverIn}
      onHoverOut={onHoverOut}
      className={`flex-row items-center gap-2 rounded-md px-3 py-2 ${disabled ? 'opacity-60' : 'hover:bg-muted focus:bg-muted'} ${active ? 'bg-muted' : ''}`}
    >
      {icon ? <Icon as={icon} size="xs" className="text-muted-foreground" /> : null}
      <VStack className="flex-1">
        <Text size="sm" className="text-foreground">
          {label}
        </Text>
        {sublabel ? (
          <Text testID={`${testID}.reason`} size="2xs" className="text-muted-foreground">
            {sublabel}
          </Text>
        ) : null}
      </VStack>
      {value ? (
        <Text testID={`${testID}.value`} size="sm" className="text-muted-foreground">
          {value}
        </Text>
      ) : null}
      {trailing ? <Icon as={trailing} size="xs" className="text-muted-foreground" /> : null}
    </Pressable>
  );
}
