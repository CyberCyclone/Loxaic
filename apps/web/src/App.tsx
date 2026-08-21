import React, { useState } from "react";
import { LoginScreen } from "./screens/Login";
import { ChatSurface } from "./design-components/surfaces/ChatSurface";
import { AgentSurface } from "./design-components/surfaces/AgentSurface";
import { RoutinesSurface } from "./design-components/surfaces/RoutinesSurface";
import { StatsSurface } from "./design-components/surfaces/StatsSurface";

type Screen = "chat" | "agent" | "routines" | "stats";

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>("chat");

  if (!token) return <LoginScreen onLogin={setToken} />;

  const handleNavigate = (surface: string) => {
    setScreen(surface as Screen);
  };

  if (screen === "chat") return <ChatSurface onNavigate={handleNavigate} token={token} />;
  if (screen === "agent") return <AgentSurface onNavigate={handleNavigate} />;
  if (screen === "routines") return <RoutinesSurface onNavigate={handleNavigate} />;
  if (screen === "stats") return <StatsSurface onNavigate={handleNavigate} />;

  return null;
}