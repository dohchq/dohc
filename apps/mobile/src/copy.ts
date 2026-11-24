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
 * "Copied". The second item marks a copy, and each copy starts the 1.5 s again.
 */
export function useCopiedMark(): readonly [boolean, () => void] {
  const [copies, setCopies] = useState(0);
  useEffect(() => {
    if (copies === 0) return;
    const timer = setTimeout(() => setCopies(0), 1500);
    return () => clearTimeout(timer);
  }, [copies]);
  return [copies > 0, useCallback(() => setCopies((count) => count + 1), [])];
}
