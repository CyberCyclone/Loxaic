import React from "react";
import { View, Text, Pressable, TextInput, type ViewStyle, type TextStyle } from "react-native";
import { useTheme } from "../theme";

export type ButtonProps = {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  style?: ViewStyle;
};

export function Button({ label, onPress, variant = "primary", size = "md", disabled, style }: ButtonProps) {
  const { theme } = useTheme();
  const c = theme.colors;
  const heights = { sm: 28, md: 32, lg: 40 };
  const fontSizes = { sm: 12, md: 13, lg: 14 };
  const paddingX = { sm: 10, md: 14, lg: 18 };

  const bg = variant === "primary" ? c.accent
    : variant === "danger" ? c.danger
    : variant === "secondary" ? c.bg.tertiary
    : "transparent";
  const fg = variant === "ghost" ? c.fg.secondary : c.onAccent;
  const border = variant === "secondary" ? c.border : "transparent";

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={{
        backgroundColor: bg,
        borderRadius: theme.radii.sm,
        paddingHorizontal: paddingX[size],
        minHeight: heights[size],
        opacity: disabled ? 0.5 : 1,
        borderWidth: variant === "secondary" ? 1 : 0,
        borderColor: border,
        ...style,
      } as ViewStyle}
    >
      <Text style={{ color: fg, fontSize: fontSizes[size], fontWeight: "500", textAlign: "center" } as TextStyle}>
        {label}
      </Text>
    </Pressable>
  );
}

export type InputProps = {
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  secureTextEntry?: boolean;
  style?: ViewStyle;
};

export function Input({ value, onChangeText, placeholder, multiline, secureTextEntry, style }: InputProps) {
  const { theme } = useTheme();
  return (
    <View
      style={{
        backgroundColor: theme.colors.bg.primary,
        borderRadius: theme.radii.sm,
        borderWidth: 1,
        borderColor: theme.colors.border,
        paddingHorizontal: theme.spacing.sm,
        paddingVertical: theme.spacing.xs,
        minHeight: 32,
        ...style,
      }}
    >
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        multiline={multiline}
        secureTextEntry={secureTextEntry}
        placeholderTextColor={theme.colors.fg.muted}
        style={{
          color: theme.colors.fg.primary,
          fontSize: theme.fontSizes.sm,
        }}
      />
    </View>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const { theme } = useTheme();
  return (
    <View style={{
      backgroundColor: theme.colors.bg.secondary,
      borderRadius: theme.radii.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
      padding: theme.spacing.md,
      ...style,
    }}>
      {children}
    </View>
  );
}

export function Avatar({ initials, size = 32 }: { initials: string; size?: number }) {
  const { theme } = useTheme();
  return (
    <View style={{
      width: size,
      height: size,
      borderRadius: theme.radii.full,
      backgroundColor: theme.colors.accent,
      alignItems: "center",
      justifyContent: "center",
    }}>
      <Text style={{ color: theme.colors.onAccent, fontSize: size * 0.4, fontWeight: "600" }}>
        {initials}
      </Text>
    </View>
  );
}

export function Badge({ label, variant = "default" }: { label: string; variant?: "default" | "server" | "device" | "success" | "danger" | "warning" | "chat" | "agent" | "routine" }) {
  const { theme } = useTheme();
  const c = theme.colors;
  const tint = variant === "server" ? c.tint.accent
    : variant === "device" ? c.tint.muted
    : variant === "success" ? c.tint.success
    : variant === "danger" ? c.tint.danger
    : variant === "warning" ? c.tint.warning
    : variant === "chat" ? c.tint.accent
    : variant === "agent" ? c.tint.success
    : variant === "routine" ? c.tint.muted
    : c.tint.muted;
  const color = variant === "server" ? c.accent
    : variant === "device" ? c.fg.secondary
    : variant === "success" ? c.success
    : variant === "danger" ? c.danger
    : variant === "warning" ? c.warning
    : variant === "chat" ? c.accent
    : variant === "agent" ? c.success
    : variant === "routine" ? c.fg.secondary
    : c.fg.secondary;

  return (
    <View style={{
      backgroundColor: tint,
      borderRadius: theme.radii.sm,
      paddingHorizontal: theme.spacing.xs,
      paddingVertical: 2,
    }}>
      <Text style={{ color, fontSize: theme.fontSizes.xs, fontWeight: "500" }}>{label}</Text>
    </View>
  );
}

export function Separator({ style }: { style?: ViewStyle }) {
  const { theme } = useTheme();
  return (
    <View style={{ height: 1, backgroundColor: theme.colors.border, ...style }} />
  );
}

export type SwitchProps = {
  value: boolean;
  onValueChange: (v: boolean) => void;
};

export function Switch({ value, onValueChange }: SwitchProps) {
  const { theme } = useTheme();
  return (
    <Pressable onPress={() => onValueChange(!value)}>
      <View style={{
        width: 36,
        height: 20,
        borderRadius: theme.radii.full,
        backgroundColor: value ? theme.colors.accent : theme.colors.bg.tertiary,
        position: "relative",
      }}>
        <View style={{
          position: "absolute",
          top: 2,
          left: value ? 18 : 2,
          width: 16,
          height: 16,
          borderRadius: theme.radii.full,
          backgroundColor: theme.colors.fg.primary,
        }} />
      </View>
    </Pressable>
  );
}

export type SegmentedControlProps = {
  options: { label: string; value: string }[];
  value: string;
  onChange: (v: string) => void;
};

export function SegmentedControl({ options, value, onChange }: SegmentedControlProps) {
  const { theme } = useTheme();
  return (
    <View style={{
      flexDirection: "row",
      gap: 4,
      backgroundColor: theme.colors.bg.primary,
      borderRadius: theme.radii.sm,
      padding: 2,
      borderWidth: 1,
      borderColor: theme.colors.border,
    }}>
      {options.map((opt) => (
        <Pressable key={opt.value} onPress={() => onChange(opt.value)}>
          <View style={{
            paddingVertical: 6,
            paddingHorizontal: 14,
            borderRadius: theme.radii.sm,
            backgroundColor: value === opt.value ? theme.colors.accent : "transparent",
            color: value === opt.value ? theme.colors.onAccent : theme.colors.fg.muted,
          }}>
            <Text style={{
              fontSize: theme.fontSizes.sm,
              color: value === opt.value ? theme.colors.onAccent : theme.colors.fg.muted,
              fontWeight: "500",
            }}>{opt.label}</Text>
          </View>
        </Pressable>
      ))}
    </View>
  );
}
