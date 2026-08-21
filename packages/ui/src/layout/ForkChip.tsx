import React from "react";
import { View, Text, Pressable, type ViewStyle } from "react-native";
import { useTheme } from "../theme";

export type BranchInfo = {
  messageId: string;
  preview: string;
  origin: "server" | "device";
  model?: string;
};

export function ForkChip({
  branchCount,
  branches,
  onSelectBranch,
  onDeleteBranch,
  onJumpToBranch,
  style,
}: {
  branchCount: number;
  branches: BranchInfo[];
  onSelectBranch: (id: string) => void;
  onDeleteBranch?: (id: string) => void;
  onJumpToBranch?: (id: string) => void;
  style?: ViewStyle;
}) {
  const { theme } = useTheme();
  const [open, setOpen] = React.useState(false);

  return (
    <View style={{ position: "relative", ...style } as ViewStyle}>
      <Pressable onPress={() => setOpen(!open)}>
        <View
          style={{
            backgroundColor: theme.colors.accent + "33",
            borderRadius: theme.radii.full,
            paddingHorizontal: 8,
            paddingVertical: 2,
            flexDirection: "row" as "row",
            alignItems: "center",
            gap: 4,
          }}
        >
          <Text style={{ color: theme.colors.accent, fontSize: 11, fontWeight: "600" }}>
            {branchCount} branches
          </Text>
        </View>
      </Pressable>
      {open && (
        <View
          style={{
            position: "absolute",
            top: 24,
            left: 0,
            backgroundColor: theme.colors.bg.secondary,
            borderRadius: theme.radii.md,
            borderWidth: 1,
            borderColor: theme.colors.border,
            padding: 8,
            minWidth: 220,
            zIndex: 100,
            shadowColor: "#000",
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.3,
            shadowRadius: 8,
          } as ViewStyle}
        >
          <Text style={{ color: theme.colors.fg.muted, fontSize: 11, marginBottom: 8 }}>
            Choose a branch to continue:
          </Text>
          {branches.map((b) => (
            <Pressable
              key={b.messageId}
              onPress={() => {
                onSelectBranch(b.messageId);
                setOpen(false);
              }}
              style={{
                paddingVertical: 6,
                paddingHorizontal: 8,
                flexDirection: "row" as "row",
                justifyContent: "space-between",
                alignItems: "center",
                borderRadius: theme.radii.sm,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text
                  numberOfLines={1}
                  style={{ color: theme.colors.fg.primary, fontSize: 12 }}
                >
                  {b.preview || "Empty branch"}
                </Text>
                <Text style={{ color: theme.colors.fg.muted, fontSize: 10 }}>
                  {b.origin === "device" ? "Local " : "Server "}
                  {b.model && `• ${b.model}`}
                </Text>
              </View>
              <View style={{ flexDirection: "row" as "row", gap: 4 }}>
                {onJumpToBranch && (
                  <Pressable onPress={() => onJumpToBranch(b.messageId)}>
                    <Text style={{ color: theme.colors.fg.muted, fontSize: 10 }}>[Jump]</Text>
                  </Pressable>
                )}
                {onDeleteBranch && (
                  <Pressable onPress={() => onDeleteBranch(b.messageId)}>
                    <Text style={{ color: theme.colors.danger, fontSize: 10 }}>[Delete]</Text>
                  </Pressable>
                )}
              </View>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}