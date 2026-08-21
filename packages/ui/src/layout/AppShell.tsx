import React from "react";
import { View, type ViewStyle } from "react-native";
import { useTheme } from "../theme";
import { Sidebar, ThreadList, ChatView, Composer } from "./components";

export function AppShell() {
  const { theme } = useTheme();
  const [_activeView, setActiveView] = React.useState<"chat" | "agent" | "routines" | "stats" | "settings">("chat");

  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: theme.colors.bg.primary } as ViewStyle}>
      <Sidebar onNavigate={setActiveView} activeView={_activeView} />
      <ThreadList onSelect={() => {}} />
      <View style={{ flex: 1, flexDirection: "column" } as ViewStyle}>
        <ChatView style={{ flex: 1 }} />
        <Composer />
      </View>
    </View>
  );
}
