import { accountWords } from "@dohc/interface-words/account";
import { confirmWords } from "@dohc/interface-words/confirmations";
import { StatusBar } from "expo-status-bar";
import { ScanQrCode } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputInstance } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DohcMark } from "../DohcMark";
import { ServerError } from "../server/client";
import { checkServerAddress, serverName } from "../server/origin";
import { useTheme } from "../theme";
import { useAccount } from "./AccountProvider";
import { Button } from "./Button";
import { ProblemLine } from "./ProblemLine";
import { ScanSheet } from "./ScanSheet";

type Phase =
  | { readonly kind: "form" }
  | { readonly kind: "starting" }
  | { readonly kind: "code"; readonly server: string; readonly userCode: string; readonly approvalUrl: string };

// Plain HTTP to the development server only in a development build.
const check = (address: string) => checkServerAddress(address, { developmentServer: __DEV__ });

const ADDRESS_PROBLEM = { empty: accountWords.enterAddress, insecure: accountWords.enterHttps, invalid: accountWords.enterAddressLike } as const;

// Connecting this phone to a server: the address, typed or scanned from a computer's Connect a phone code, then the
// server's device sign-in. The phone opens the server's approval page in the system browser, with its code filled in,
// and polls until the person approves it there. The page doesn't return to the app, so the browser opens as a plain
// sheet and closes once the phone is signed in.
export function Connect() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { account, state } = useAccount();
  const last = state.status === "signed-out" ? state : null;
  const [address, setAddress] = useState(last?.origin ?? "");
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  // What the field holds that has to change, shown under it.
  const [addressProblem, setAddressProblem] = useState<string | null>(null);
  // What the last attempt ended with, above the button that tries again.
  const [outcome, setOutcome] = useState<string | null>(last?.ended && last.origin ? accountWords.sessionEnded(serverName(last.origin)) : null);
  const field = useRef<TextInputInstance>(null);
  // The scanner's sheet. Each opening is a new session, so it asks for the camera again and forgets earlier scans.
  const [scan, setScan] = useState({ open: false, session: 0 });

  // Leaving this screen ends a sign-in still in progress. Once signed in, it has nothing to end.
  useEffect(() => () => account.cancelSignIn(), [account]);

  async function connect(value = address) {
    const checked = check(value);
    if ("problem" in checked) {
      setAddressProblem(ADDRESS_PROBLEM[checked.problem]);
      field.current?.focus();
      return;
    }
    const { origin } = checked;
    setAddress(origin);
    setAddressProblem(null);
    setOutcome(null);
    setPhase({ kind: "starting" });
    try {
      const result = await account.signIn(origin, code => {
        setPhase({ kind: "code", server: serverName(origin), ...code });
        void openApproval(code.approvalUrl);
      });
      if (result === "cancelled") return;
      void closeApproval();
      if (result === "signed-in") return;
      setOutcome(result === "denied" ? accountWords.denied : accountWords.expired);
      setPhase({ kind: "form" });
    } catch (error) {
      void closeApproval();
      const server = serverName(origin);
      const problem = error instanceof ServerError ? error.problem : "refused";
      setOutcome(problem === "offline" || problem === "server-busy" ? accountWords.problem(problem, server) : accountWords.couldNotSignIn(server));
      setPhase({ kind: "form" });
    }
  }

  // A scanned address only fills the field, as typing it does. The person still chooses Connect server, so a code
  // someone swapped onto a poster or into a message can't open a server's sign-in page by itself. Focus isn't moved:
  // as on the desktop, it belongs back on the control that opened the sheet, and Connect server follows it.
  function scanFound(origin: string) {
    setScan(current => ({ ...current, open: false }));
    setAddress(origin);
    setAddressProblem(null);
  }

  function cancel() {
    account.cancelSignIn();
    setPhase({ kind: "form" });
  }

  const busy = phase.kind === "starting";
  return (
    <View style={[styles.screen, { backgroundColor: theme.bg }]}>
      <StatusBar style="auto" />
      <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 24 }]}>
        <DohcMark size={40} color={theme.ink} />
        {phase.kind === "code" ? (
          <View style={styles.block}>
            <Text style={[styles.title, { color: theme.ink }]}>{accountWords.signingInTo(phase.server)}</Text>
            <Text style={[styles.body, { color: theme.ink }]}>{accountWords.approveInBrowser}</Text>
            <Text style={[styles.code, { color: theme.ink }]} selectable accessibilityLabel={phase.userCode.split("").join(" ")}>{phase.userCode}</Text>
            <Button label={accountWords.openBrowser} onPress={() => void openApproval(phase.approvalUrl)} />
            <View style={styles.waiting} accessibilityRole="text" accessibilityLiveRegion="polite">
              <ActivityIndicator color={theme.muted} />
              <Text style={[styles.note, { color: theme.muted }]}>{accountWords.waitingForApproval}</Text>
            </View>
            <Button label={confirmWords.cancel} quiet onPress={cancel} />
          </View>
        ) : (
          <View style={styles.block}>
            {/* The last sign-out could not delete its token, so it is still on this phone. */}
            {last?.forgetFailed ? <ProblemLine text={accountWords.forgetFailed} onRetry={() => void account.retryForget()} /> : null}
            <Text style={[styles.label, { color: theme.muted }]}>{accountWords.serverAddress}</Text>
            <View style={styles.addressRow}>
              <TextInput
                ref={field}
                value={address}
                onChangeText={text => { setAddress(text); setAddressProblem(null); }}
                onBlur={() => {
                  if (busy || !address.trim()) return;
                  const checked = check(address);
                  setAddressProblem("problem" in checked ? ADDRESS_PROBLEM[checked.problem] : null);
                }}
                onSubmitEditing={() => void connect()}
                editable={!busy}
                placeholder={accountWords.serverAddressExample}
                placeholderTextColor={theme.subtle}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                keyboardType="url"
                textContentType="URL"
                returnKeyType="go"
                accessibilityLabel={accountWords.serverAddress}
                style={[styles.input, { color: busy ? theme.muted : theme.ink, backgroundColor: theme.field, borderColor: addressProblem ? theme.danger : "transparent" }]}
              />
              <Pressable accessibilityRole="button" accessibilityLabel={accountWords.scanCode} accessibilityState={{ disabled: busy }} disabled={busy}
                onPress={() => setScan(current => ({ open: true, session: current.session + 1 }))}
                style={({ pressed }) => [styles.scan, { backgroundColor: theme.field, opacity: busy ? 0.4 : pressed ? 0.7 : 1 }]}>
                <ScanQrCode size={22} color={theme.ink} strokeWidth={1.9} />
              </Pressable>
            </View>
            {addressProblem ? <Text style={[styles.note, { color: theme.danger }]} accessibilityLiveRegion="polite">{addressProblem}</Text> : null}
            {outcome ? <Text style={[styles.body, { color: theme.danger }]} accessibilityRole="alert">{outcome}</Text> : null}
            <Button label={busy ? accountWords.connecting : accountWords.connectServer} disabled={busy} onPress={() => void connect()} />
          </View>
        )}
      </ScrollView>
      <ScanSheet open={scan.open} session={scan.session} onClose={() => setScan(current => ({ ...current, open: false }))} onScanned={scanFound} />
    </View>
  );
}

// The system browser's sheet. If it can't open, Open browser stays on screen to try again. The module loads on first
// use: a sample build loads this file too, and its binary may predate the browser's native module.
const browser = () => import("expo-web-browser");

async function openApproval(url: string): Promise<void> {
  await browser().then(module => module.openBrowserAsync(url)).catch(() => undefined);
}

// Closes the sheet on iOS. On Android the person closes the browser's tab.
async function closeApproval(): Promise<void> {
  await browser().then(module => module.dismissBrowser()).catch(() => undefined);
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { paddingHorizontal: 24, gap: 32 },
  block: { gap: 12 },
  label: { fontSize: 15 },
  addressRow: { flexDirection: "row", gap: 8 },
  input: { flex: 1, minHeight: 44, borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, fontSize: 17 },
  scan: { width: 44, minHeight: 44, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  title: { fontSize: 20, fontWeight: "600" },
  body: { fontSize: 17, lineHeight: 22 },
  note: { fontSize: 15, lineHeight: 20 },
  code: { fontSize: 32, fontWeight: "600", letterSpacing: 6, textAlign: "center", marginVertical: 8, fontVariant: ["tabular-nums"] },
  waiting: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
});
