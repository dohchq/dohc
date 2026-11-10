import { accountWords } from "@dohc/interface-words/account";
import { confirmWords } from "@dohc/interface-words/confirmations";
import type { BarcodeScanningResult } from "expo-camera";
import * as Haptics from "expo-haptics";
import { CameraOff } from "lucide-react-native";
import { useEffect, useState } from "react";
import { AppState, Linking, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme";
import { Button } from "./Button";
import { cameraAccess, scanReader } from "./scan";

type Camera = typeof import("expo-camera");

type Step =
  | { readonly kind: "opening" }
  | { readonly kind: "scanning" | "denied"; readonly camera: Camera }
  | { readonly kind: "failed" };

// The camera's own surface, black in both themes, with a white frame to aim at.
const CAMERA_FILL = "#000000";
const FRAME = "#ffffff";

// Connect's scanner for a computer's Connect a phone code, as a system sheet over Connect. Each opening starts afresh:
// `session` changes, so the camera is asked for again and no earlier scan counts. `onGone` comes once the sheet has
// left the screen: at the end of its slide on iOS, and as it hides on Android, whose Modal has no onDismiss.
export function ScanSheet({ open, session, onClose, onScanned, onGone }: {
  open: boolean;
  session: number;
  onClose(): void;
  onScanned(origin: string): void;
  onGone(): void;
}) {
  useEffect(() => {
    if (!open && Platform.OS !== "ios") onGone();
  }, [open, onGone]);
  return (
    <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}
      onDismiss={Platform.OS === "ios" ? onGone : undefined}>
      <ScanContent key={session} active={open} onClose={onClose} onScanned={onScanned} />
    </Modal>
  );
}

function ScanContent({ active, onClose, onScanned }: { active: boolean; onClose(): void; onScanned(origin: string): void }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<Step>({ kind: "opening" });
  const [problem, setProblem] = useState<string | null>(null);
  const [read] = useState(() => scanReader({ developmentServer: __DEV__ }));

  // Asks for the camera as the sheet opens, which is only ever after the person taps Scan code.
  useEffect(() => {
    let current = true;
    void openCamera().then(next => { if (current) setStep(next); });
    return () => { current = false; };
  }, []);

  // Android keeps the app running while the person allows the camera in Settings, so the scanner starts on return.
  // iOS restarts the app when its camera permission changes.
  useEffect(() => {
    if (step.kind !== "denied") return;
    const { camera } = step;
    let current = true;
    const subscription = AppState.addEventListener("change", next => {
      if (next !== "active") return;
      void camera.Camera.getCameraPermissionsAsync().then(
        permission => { if (current && permission.granted) setStep({ kind: "scanning", camera }); },
        () => undefined,
      );
    });
    return () => { current = false; subscription.remove(); };
  }, [step]);

  function scanned({ data }: BarcodeScanningResult) {
    // The sheet keeps scanning while it slides away after Cancel.
    if (!active) return;
    const result = read(data);
    if (result === null) return;
    if ("origin" in result) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onScanned(result.origin);
      return;
    }
    setProblem(result.problem === "insecure" ? accountWords.insecureCode : accountWords.notServerCode);
  }

  return (
    <View style={[styles.sheet, { backgroundColor: theme.bg, paddingTop: Platform.OS === "ios" ? 8 : insets.top + 8, paddingBottom: insets.bottom + 16 }]}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={onClose} hitSlop={8} style={styles.cancel}>
          <Text style={[styles.cancelLabel, { color: theme.ink }]}>{confirmWords.cancel}</Text>
        </Pressable>
      </View>
      {step.kind === "opening" || step.kind === "scanning" ? (
        <>
          <View style={[styles.camera, { backgroundColor: CAMERA_FILL }]}>
            {step.kind === "scanning" ? (
              <step.camera.CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={active ? scanned : undefined} onMountError={() => setStep({ kind: "failed" })} />
            ) : null}
            <View pointerEvents="none" style={[styles.frame, { borderColor: FRAME }]} />
          </View>
          {problem ? (
            <Text style={[styles.line, { color: theme.danger }]} accessibilityRole="alert">{problem}</Text>
          ) : (
            <Text style={[styles.line, { color: theme.muted }]} accessibilityLiveRegion="polite">{accountWords.scanHint}</Text>
          )}
        </>
      ) : (
        <View style={styles.state}>
          <View style={styles.icon}><CameraOff size={32} color={theme.muted} strokeWidth={1.9} /></View>
          {step.kind === "denied" ? (
            <>
              <Text style={[styles.stateText, { color: theme.ink }]}>{accountWords.cameraOff}</Text>
              <Button label={accountWords.openSettings} onPress={() => void Linking.openSettings()} />
            </>
          ) : (
            <Text style={[styles.stateText, { color: theme.danger }]} accessibilityRole="alert">{accountWords.cameraFailed}</Text>
          )}
        </View>
      )}
    </View>
  );
}

// expo-camera loads on first use: a sample build loads Connect too, and its binary may predate the camera's native
// module. A binary without it shows the failed state.
async function openCamera(): Promise<Step> {
  try {
    const camera = await import("expo-camera");
    const access = await cameraAccess({
      get: () => camera.Camera.getCameraPermissionsAsync(),
      request: () => camera.Camera.requestCameraPermissionsAsync(),
    });
    return { kind: access === "granted" ? "scanning" : "denied", camera };
  } catch {
    return { kind: "failed" };
  }
}

const styles = StyleSheet.create({
  sheet: { flex: 1, paddingHorizontal: 16, gap: 16 },
  header: { flexDirection: "row" },
  cancel: { minHeight: 44, justifyContent: "center" },
  cancelLabel: { fontSize: 17 },
  camera: { flex: 1, borderRadius: 16, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  frame: { width: 240, height: 240, borderRadius: 24, borderWidth: 2 },
  line: { fontSize: 15, lineHeight: 20, textAlign: "center", paddingHorizontal: 8 },
  state: { flex: 1, alignItems: "stretch", justifyContent: "center", gap: 16, paddingHorizontal: 8 },
  icon: { alignItems: "center" },
  stateText: { fontSize: 17, lineHeight: 22, textAlign: "center" },
});
