import { workspaceWords } from "@dohc/interface-words/workspace";
import { MAX_INBOX_TITLE_CHARS, validateInboxUrl } from "@dohc/workspace-contracts/inbox";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput } from "react-native";
import { useAccount } from "../account/AccountProvider";
import {
  CAPTURE_MAX_BODY_BYTES,
  capturePayloadBytes,
  type QueuedCapture,
} from "../server/captureQueue";
import { newFileRequestId } from "../server/fileWrites";
import { useTheme } from "../theme";
import { SheetModal } from "./FileNameSheet";

export function QuickCaptureSheet(props: {
  readonly open: boolean;
  readonly draft?: QueuedCapture | null;
  readonly onClose: () => void;
}) {
  const { open, draft, onClose } = props;
  const theme = useTheme();
  const { data, captureQueue } = useAccount();
  const [note, setNote] = useState("");
  const [title, setTitle] = useState("");
  const [link, setLink] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setNote(draft?.body ?? "");
    setTitle(draft?.title ?? "");
    setLink(draft?.url ?? "");
    setSaving(false);
    setError(
      draft?.stage === "withheld" ? workspaceWords.captureCouldntKeep : (draft?.reason ?? null),
    );
    requestId.current = draft?.stage === "withheld" ? draft.requestId : null;
  }, [open, draft]);

  const edit = (set: (next: string) => void) => (next: string) => {
    set(next);
    setError(null);
  };
  const fail = (message: string) => {
    setError(message);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  };

  const submit = async () => {
    if (saving || !data) return;
    const trimmedTitle = title.trim();
    const trimmedNote = note.trim();
    const trimmedLink = link.trim();
    if (!trimmedTitle && !trimmedNote && !trimmedLink)
      return fail(workspaceWords.captureEmptyError);
    if (trimmedLink) {
      try {
        validateInboxUrl(trimmedLink);
      } catch {
        return fail(workspaceWords.captureInvalidLink);
      }
    }
    const payload = {
      workspaceId: draft?.workspaceId ?? data.workspaceId,
      ...(trimmedTitle ? { title: trimmedTitle } : {}),
      ...(trimmedNote ? { body: note } : {}),
      ...(trimmedLink ? { url: trimmedLink } : {}),
      kind: (trimmedLink ? "link" : "note") as "note" | "link",
    };
    if (
      trimmedTitle.length > MAX_INBOX_TITLE_CHARS * 2 ||
      capturePayloadBytes(payload) > CAPTURE_MAX_BODY_BYTES
    )
      return fail(workspaceWords.captureTooLarge);
    const sentId = (requestId.current ??= newFileRequestId());
    setSaving(true);
    setError(null);
    try {
      await captureQueue.enqueue({ ...payload, requestId: sentId });
      if (draft && draft.requestId !== sentId) void captureQueue.discard(draft.requestId);
      requestId.current = null;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onClose();
    } catch {
      setSaving(false);
      fail(workspaceWords.captureCouldntKeep);
    }
  };

  const inputStyle = [
    styles.input,
    { color: theme.ink, backgroundColor: theme.panel, borderColor: theme.line },
  ];

  return (
    <SheetModal
      open={open}
      title={workspaceWords.quickCapture}
      saving={saving}
      savingLabel={workspaceWords.capturing}
      actionLabel={workspaceWords.captureSave}
      onClose={onClose}
      onAction={() => void submit()}
    >
      <ScrollView
        contentContainerStyle={styles.form}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <Text style={[styles.label, { color: theme.muted }]}>
          {workspaceWords.captureNoteLabel}
        </Text>
        <TextInput
          value={note}
          onChangeText={edit(setNote)}
          placeholder={workspaceWords.captureNotePlaceholder}
          placeholderTextColor={theme.subtle}
          editable={!saving}
          autoFocus
          multiline
          textAlignVertical="top"
          accessibilityLabel={workspaceWords.captureNoteLabel}
          style={[inputStyle, styles.multiline]}
        />
        <Text style={[styles.label, { color: theme.muted }]}>
          {workspaceWords.captureTitleLabel}
        </Text>
        <TextInput
          value={title}
          onChangeText={edit(setTitle)}
          placeholder={workspaceWords.captureTitlePlaceholder}
          placeholderTextColor={theme.subtle}
          editable={!saving}
          returnKeyType="next"
          accessibilityLabel={workspaceWords.captureTitleLabel}
          style={inputStyle}
        />
        <Text style={[styles.label, { color: theme.muted }]}>
          {workspaceWords.captureLinkLabel}
        </Text>
        <TextInput
          value={link}
          onChangeText={edit(setLink)}
          placeholder={workspaceWords.captureLinkPlaceholder}
          placeholderTextColor={theme.subtle}
          editable={!saving}
          keyboardType="url"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={() => void submit()}
          accessibilityLabel={workspaceWords.captureLinkLabel}
          style={inputStyle}
        />
        {error ? (
          <Text style={[styles.error, { color: theme.danger }]} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
      </ScrollView>
    </SheetModal>
  );
}

const styles = StyleSheet.create({
  form: { padding: 16, gap: 10, paddingBottom: 48 },
  label: { fontSize: 13, fontWeight: "600", marginTop: 4 },
  input: {
    fontSize: 17,
    minHeight: 46,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  multiline: { minHeight: 112 },
  error: { fontSize: 14, lineHeight: 20, marginTop: 4 },
});
