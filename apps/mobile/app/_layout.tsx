import "../global.css";
import { GluestackProvider } from "@shannon/ui/provider";
import { AppShell } from "@shannon/ui/layout";

export default function RootLayout() {
  return (
    <GluestackProvider>
      <AppShell />
    </GluestackProvider>
  );
}