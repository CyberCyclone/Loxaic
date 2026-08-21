import React from "react";
import {
  View,
  Text,
  Pressable,
  type ViewStyle,
} from "react-native";
import { useTheme } from "../theme";
import { Separator, Avatar, Badge } from "../components";
import {
  ChatIcon,
  AgentIcon,
  RoutinesIcon,
  StatsIcon,
  SettingsIcon,
} from "./icons";

const SIDEBAR_WIDTH = 260;
const THREAD_LIST_WIDTH = 280;

// ── Sidebar ──────────────────────────────────────────────
export function Sidebar({
  onNavigate,
  activeView,
  style,
}: {
  onNavigate: (view: "chat" | "agent" | "routines" | "stats" | "settings") => void;
  activeView: string;
  style?: ViewStyle;
}) {
  const { theme } = useTheme();
  const items = [
    { id: "chat" as const, icon: <ChatIcon />, label: "Chat" },
    { id: "agent" as const, icon: <AgentIcon />, label: "Agent" },
    { id: "routines" as const, icon: <RoutinesIcon />, label: "Routines" },
    { id: "stats" as const, icon: <StatsIcon />, label: "Stats" },
    { id: "settings" as const, icon: <SettingsIcon />, label: "Settings" },
  ];
  return (
    <View
      style={{
        width: SIDEBAR_WIDTH,
        backgroundColor: theme.colors.bg.secondary,
        borderRightWidth: 1,
        borderRightColor: theme.colors.border,
        display: "flex",
        flexDirection: "column",
        ...style,
      } as ViewStyle}
    >
      <View style={{ height: 56, flexDirection: "row", alignItems: "center", gap: theme.spacing.sm, padding: "0 16px", borderBottomWidth: 1, borderBottomColor: theme.colors.border } as ViewStyle}>
        <View style={{ width: 28, height: 28, borderRadius: theme.radii.sm, backgroundColor: theme.colors.accent, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ fontWeight: "600", fontSize: 13, color: theme.colors.onAccent }}>S</Text>
        </View>
        <Text style={{ color: theme.colors.fg.primary, fontSize: theme.fontSizes.sm, fontWeight: "600", letterSpacing: -0.01 }}>
          Shannon
        </Text>
      </View>
      <View style={{ flex: 1, padding: theme.spacing.sm, overflowY: "auto" }}>
        <Text style={{ fontSize: theme.fontSizes.xs, color: theme.colors.fg.muted, textTransform: "uppercase", letterSpacing: 0.04, padding: "16px 8px 6px", fontWeight: "500" }}>
          Navigate
        </Text>
        {items.map((item) => (
          <Pressable
            key={item.id}
            onPress={() => onNavigate(item.id)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: theme.spacing.sm,
              padding: "8px 10px",
              borderRadius: theme.radii.sm,
              marginBottom: 2,
              backgroundColor: activeView === item.id ? theme.colors.bg.tertiary : "transparent",
            } as ViewStyle}
          >
            <View style={{ width: 18, height: 18, opacity: activeView === item.id ? 1 : 0.8, color: activeView === item.id ? theme.colors.accent : theme.colors.fg.secondary }}>
              {item.icon}
            </View>
            <Text style={{ color: activeView === item.id ? theme.colors.fg.primary : theme.colors.fg.secondary, fontSize: theme.fontSizes.sm }}>
              {item.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={{ padding: theme.spacing.sm, borderTopWidth: 1, borderTopColor: theme.colors.border }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, padding: "4px 8px" }}>
          <View style={{ width: 6, height: 6, borderRadius: theme.radii.full, backgroundColor: theme.colors.success }} />
          <Text style={{ fontSize: theme.fontSizes.xs, color: theme.colors.fg.muted }}>Connected</Text>
        </View>
        <Pressable style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.sm, padding: theme.spacing.sm, borderRadius: theme.radii.sm }}>
          <Avatar initials="U" size={28} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontSize: theme.fontSizes.sm, fontWeight: "500", color: theme.colors.fg.primary }} numberOfLines={1}>User</Text>
            <Text style={{ fontSize: theme.fontSizes.xs, color: theme.colors.fg.muted }}>shannon.tailscale.com</Text>
          </View>
        </Pressable>
      </View>
    </View>
  );
}

// ── Thread List ──────────────────────────────────────────
type Thread = { id: string; title: string; kind: string; updated: string };

const MOCK_THREADS: Thread[] = [
  { id: "1", title: "Build the UI shell", kind: "agent", updated: "2m ago" },
  { id: "2", title: "Explain Docker networking", kind: "chat", updated: "1h ago" },
  { id: "3", title: "Debug the sync protocol", kind: "chat", updated: "3h ago" },
];

export function ThreadList({
  onSelect,
  style,
}: {
  onSelect: (id: string) => void;
  style?: ViewStyle;
}) {
  const { theme } = useTheme();
  return (
    <View
      style={{
        width: THREAD_LIST_WIDTH,
        backgroundColor: theme.colors.bg.secondary,
        borderRightWidth: 1,
        borderRightColor: theme.colors.border,
        ...style,
      } as ViewStyle}
    >
      <View style={{ height: 56, flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: "0 16px", borderBottomWidth: 1, borderBottomColor: theme.colors.border } as ViewStyle}>
        <Text style={{ color: theme.colors.fg.primary, fontSize: theme.fontSizes.sm, fontWeight: "600" }}>
          Threads
        </Text>
        <Pressable>
          <View style={{ padding: 4, borderRadius: theme.radii.sm, backgroundColor: theme.colors.accent, minHeight: 28, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 4 }}>
            <Text style={{ color: theme.colors.onAccent, fontSize: theme.fontSizes.xs, fontWeight: "500" }}>New</Text>
          </View>
        </Pressable>
      </View>
      <View style={{ padding: theme.spacing.sm }}>
        <View style={{ width: "100%", padding: "6px 10px", borderRadius: theme.radii.sm, backgroundColor: theme.colors.bg.primary, borderWidth: 1, borderColor: theme.colors.border }}>
          <Text style={{ color: theme.colors.fg.muted, fontSize: theme.fontSizes.xs }}>Search...</Text>
        </View>
      </View>
      <Separator />
      <View style={{ flex: 1, overflowY: "auto", padding: "0 4px 8px" }}>
        {MOCK_THREADS.map((t) => (
          <Pressable
            key={t.id}
            onPress={() => onSelect(t.id)}
            style={{
              padding: "10px 12px",
              borderRadius: theme.radii.sm,
              marginBottom: 1,
            } as ViewStyle}
          >
            <Text
              numberOfLines={1}
              style={{ color: theme.colors.fg.primary, fontSize: theme.fontSizes.sm, flex: 1, fontWeight: "500", marginBottom: 2 }}
            >
              {t.title}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Badge label={t.kind} variant={t.kind as "chat" | "agent" | "routine"} />
              <Text style={{ color: theme.colors.fg.muted, fontSize: theme.fontSizes.xs }}>
                {t.updated}
              </Text>
            </View>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

// ── Chat View (placeholder) ──────────────────────────────
export function ChatView({ style }: { style?: ViewStyle }) {
  const { theme } = useTheme();
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        ...style,
      } as ViewStyle}
    >
      <Text style={{ color: theme.colors.fg.muted, fontSize: theme.fontSizes.lg }}>
        Select a thread or start a new conversation
      </Text>
    </View>
  );
}

// ── Composer (placeholder) ───────────────────────────────
export function Composer({ style }: { style?: ViewStyle }) {
  const { theme } = useTheme();
  return (
    <View
      style={{
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        padding: theme.spacing.md,
        backgroundColor: theme.colors.bg.secondary,
        ...style,
      } as ViewStyle}
    >
      <View
        style={{
          borderRadius: theme.radii.md,
          borderWidth: 1,
          borderColor: theme.colors.border,
          padding: theme.spacing.sm,
          minHeight: 44,
          backgroundColor: theme.colors.bg.primary,
        }}
      >
        <Text style={{ color: theme.colors.fg.muted, fontSize: theme.fontSizes.sm }}>
          Message Shannon...
        </Text>
      </View>
    </View>
  );
}
