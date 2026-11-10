import { accountWords } from "@dohc/interface-words/account";
import { documentWords } from "@dohc/interface-words/documents";
import { noticesWords } from "@dohc/interface-words/notices";
import { AlertTriangle } from "lucide-react-native";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useAccount, useSignIn } from "../account/AccountProvider";
import { ProblemLine } from "../account/ProblemLine";
import { DohcMark } from "../DohcMark";
import { ActionPill } from "../notices/ActionPill";
import { serverName } from "../server/origin";
import { useTheme } from "../theme";

// The states a list on a tab shows in its own place, as the desktop's Home and chat list do.

/**
 * A list that could not load: the desktop's RetryRow, a warning mark and Try again. The cause is in the toast and the
 * Notices row, so VoiceOver hears the toast's title here instead.
 */
export function RetryRow({ label, onRetry }: { label: string; onRetry(): void }) {
  const theme = useTheme();
  return (
    <View style={styles.retry} accessible accessibilityLabel={label} accessibilityActions={[{ name: "activate", label: noticesWords.tryAgain }]}
      onAccessibilityAction={onRetry}>
      <AlertTriangle size={16} color={theme.danger} strokeWidth={2} />
      <ActionPill label={noticesWords.tryAgain} onPress={onRetry} />
    </View>
  );
}

/**
 * A list still being read: one row's height, blank, so nothing claims to be empty too soon. Past 150 ms it says so to
 * VoiceOver, as the desktop's skeleton does.
 */
export function HoldRow() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), 150);
    return () => clearTimeout(timer);
  }, []);
  return <View style={styles.hold} accessible={shown} accessibilityLabel={shown ? documentWords.loading : undefined} />;
}

/** One muted line where a list has nothing: `No pages yet.` */
export function EmptyLine({ text }: { text: string }) {
  const theme = useTheme();
  return <Text style={[styles.empty, { color: theme.muted }]}>{text}</Text>;
}

/**
 * What a tab shows without a workspace open: why the account's list could not load, with Try again, or why no
 * workspace shows on the phone. Null while the list loads, or once a workspace is open.
 */
export function NoWorkspace() {
  const theme = useTheme();
  const { workspaces: list, currentWorkspaceId, reloadWorkspaces } = useAccount();
  const server = serverName(useSignIn().origin);
  if (list.status === "failed") return <View style={styles.message}><ProblemLine text={accountWords.problem(list.problem, server)} onRetry={reloadWorkspaces} /></View>;
  if (list.status !== "ready" || currentWorkspaceId !== null) return null;
  const text = list.workspaces.length === 0 ? accountWords.noWorkspaces(server) : accountWords.noneShown;
  return <View style={styles.message}><Text style={[styles.text, { color: theme.muted }]}>{text}</Text></View>;
}

/**
 * A chat or page that could not be read, in place of it, as the desktop's empty state: a failure draws the triangle in
 * danger and offers Try again; something that's gone draws the dohc mark and offers nothing. A screen outside the tabs
 * shows its failure here, since toasts show only on the tabs (dohc-interface, "The phone app").
 */
export function ScreenFailure({ text, cause, onRetry }: { text: string; cause?: string; onRetry?(): void }) {
  const theme = useTheme();
  return (
    <View style={styles.failure}>
      {onRetry ? <AlertTriangle size={22} color={theme.danger} strokeWidth={1.9} /> : <DohcMark size={30} color={theme.line} />}
      <Text style={[styles.failureText, { color: theme.muted }]} accessibilityRole={onRetry ? "alert" : undefined}>{text}</Text>
      {cause ? <Text style={[styles.failureText, { color: theme.muted }]}>{cause}</Text> : null}
      {onRetry ? <ActionPill label={noticesWords.tryAgain} onPress={onRetry} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  failure: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingHorizontal: 32, paddingBottom: 80 },
  failureText: { fontSize: 15, lineHeight: 20, textAlign: "center" },
  retry: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44, paddingHorizontal: 16 },
  hold: { height: 44 },
  empty: { fontSize: 15, lineHeight: 20, paddingHorizontal: 16, paddingVertical: 12 },
  message: { paddingHorizontal: 16, paddingTop: 24 },
  text: { fontSize: 17, lineHeight: 22 },
});
