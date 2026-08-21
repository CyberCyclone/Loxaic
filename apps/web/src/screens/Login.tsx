import React, { useState } from "react";
import { View, Text, TextInput, Pressable, type ViewStyle } from "react-native";
import { signUp, signIn } from "@shannon/api-client";
import { useTheme } from "@shannon/ui/theme";

export function LoginScreen({ onLogin }: { onLogin: (token: string) => void }) {
  const { theme } = useTheme();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const handleSignIn = async () => {
    setError("");
    try {
      const result = await signIn(email, password);
      onLogin(result.token);
    } catch {
      try {
        const result = await signUp(email, password);
        onLogin(result.token);
      } catch (e) {
        setError((e as Error).message);
      }
    }
  };

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32, backgroundColor: theme.colors.bg.primary } as ViewStyle}>
      <Text style={{ color: theme.colors.fg.primary, fontSize: 24, fontWeight: "700", marginBottom: 32 }}>
        Shannon
      </Text>
      <View style={{ width: "100%", maxWidth: 360, gap: 12 } as ViewStyle}>
        <TextInput
          placeholder="Email"
          placeholderTextColor={theme.colors.fg.muted}
          value={email}
          onChangeText={setEmail}
          style={{
            backgroundColor: theme.colors.bg.secondary,
            color: theme.colors.fg.primary,
            borderRadius: theme.radii.md,
            borderWidth: 1,
            borderColor: theme.colors.border,
            padding: 12,
            fontSize: 14,
          } as ViewStyle}
        />
        <TextInput
          placeholder="Password"
          placeholderTextColor={theme.colors.fg.muted}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          style={{
            backgroundColor: theme.colors.bg.secondary,
            color: theme.colors.fg.primary,
            borderRadius: theme.radii.md,
            borderWidth: 1,
            borderColor: theme.colors.border,
            padding: 12,
            fontSize: 14,
          } as ViewStyle}
        />
        {error ? (
          <Text style={{ color: theme.colors.danger, fontSize: 12 }}>{error}</Text>
        ) : null}
        <Pressable onPress={handleSignIn}>
          <View style={{
            backgroundColor: theme.colors.accent,
            borderRadius: theme.radii.md,
            padding: 12,
            alignItems: "center",
          }}>
            <Text style={{ color: theme.colors.onAccent, fontSize: 14, fontWeight: "600" }}>
              Sign In / Sign Up
            </Text>
          </View>
        </Pressable>
      </View>
    </View>
  );
}
