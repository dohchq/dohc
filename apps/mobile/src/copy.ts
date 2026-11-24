import { documentWords } from "@dohc/interface-words/documents";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useState } from "react";
import { AccessibilityInfo, Clipboard } from "react-native";

export function copyText(text: string) {
  Clipboard.setString(text);
  // A light tap, as the check is neutral: a copy is a small acknowledgment, not a finished task.
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  AccessibilityInfo.announceForAccessibility(documentWords.copied);
}

/**
 * Whether a copy just happened: for 1.5 s a check stands in for the control that copied, as the desktop's menu row says
 * "Copied". The second item marks a copy.
 */
export function useCopiedMark(): readonly [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return [copied, useCallback(() => setCopied(true), [])];
}
