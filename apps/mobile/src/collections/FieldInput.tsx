import { collectionWords } from "@dohc/interface-words/collections";
import { noticesWords } from "@dohc/interface-words/notices";
import type { DatasetColumnFieldType } from "@dohc/security-contract/dataset";
import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import * as Crypto from "expo-crypto";
import * as Haptics from "expo-haptics";
import { Check, ChevronRight, Paperclip } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { ActionPill } from "../notices/ActionPill";
import { encodeBase64, MAX_ATTACHMENT_UPLOAD_BYTES, pickDocument } from "../server/binaryFiles";
import { shownProblem } from "../server/client";
import type { CollectionRelation, RecordId } from "../server/phoneCollections";
import { useTheme } from "../theme";
import { ripple, TOUCH } from "../touch";
import { useProblemText } from "../workspace/useView";
import { dateOf, dayOf, rowText, shownValue, type Draft } from "./collectionFields";
import type { WorkspaceCollections } from "./collectionStore";

type PendingAttachment = {
  readonly fieldId: string;
  readonly idempotencyKey: string;
  readonly name: string;
  readonly contentType: string;
  readonly bytesBase64: string;
};

export function useAttachmentUpload(options: {
  readonly store: WorkspaceCollections;
  readonly tableId: string;
  readonly revision?: number;
  readonly revisionSha256?: string;
  readonly onUploaded: (fieldId: string, fileId: string, name: string) => void;
}) {
  const { store, tableId, revision, revisionSha256, onUploaded } = options;
  const problemText = useProblemText();
  const [uploadingField, setUploadingField] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [retryable, setRetryable] = useState<PendingAttachment | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  const send = useCallback(
    async (payload: PendingAttachment) => {
      setUploadingField(payload.fieldId);
      setErrors((cur) => {
        const next = { ...cur };
        delete next[payload.fieldId];
        return next;
      });
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const answer = await store.uploadAttachment(
          {
            tableId,
            fieldId: payload.fieldId,
            ...(revision !== undefined ? { revision } : {}),
            ...(revisionSha256 !== undefined ? { revisionSha256 } : {}),
            idempotencyKey: payload.idempotencyKey,
            name: payload.name,
            contentType: payload.contentType,
            bytesBase64: payload.bytesBase64,
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setRetryable(null);
        if (answer.kind === "uploaded") {
          onUploaded(payload.fieldId, answer.file.fileId, answer.file.name);
        } else {
          setErrors((cur) => ({
            ...cur,
            [payload.fieldId]:
              answer.kind === "rulesChanged"
                ? collectionWords.rulesChanged
                : collectionWords.refused(answer.message),
          }));
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        const problem = shownProblem(error);
        if (problem !== null) {
          setRetryable(payload);
          setErrors((cur) => ({
            ...cur,
            [payload.fieldId]: `${collectionWords.attachmentUploadFailed} ${problemText(problem)}`,
          }));
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setUploadingField(null);
      }
    },
    [onUploaded, problemText, revision, revisionSha256, store, tableId],
  );
  const pick = useCallback(
    async (fieldId: string) => {
      if (uploadingField !== null) return;
      const picked = await pickDocument(MAX_ATTACHMENT_UPLOAD_BYTES);
      if (!picked.ok) {
        const msg =
          picked.reason === "too-large"
            ? collectionWords.attachmentTooLarge
            : picked.reason === "empty"
              ? collectionWords.attachmentEmpty
              : picked.reason === "unreadable"
                ? collectionWords.attachmentUploadFailed
                : null;
        if (msg) setErrors((cur) => ({ ...cur, [fieldId]: msg }));
        return;
      }
      await send({
        fieldId,
        idempotencyKey: Crypto.randomUUID(),
        name: picked.name,
        contentType: picked.mimeType,
        bytesBase64: encodeBase64(picked.bytes),
      });
    },
    [send, uploadingField],
  );
  return {
    uploadingField,
    errors,
    retryable,
    pick,
    retry: () => {
      if (retryable && uploadingField === null) void send(retryable);
    },
    reset: () => {
      abortRef.current?.abort();
      setUploadingField(null);
      setErrors({});
      setRetryable(null);
    },
  };
}

export interface FieldInputSpec {
  readonly name: string;
  readonly type: DatasetColumnFieldType;
  readonly options?: readonly string[];
  readonly relation?: CollectionRelation;
  readonly required?: boolean;
}

export interface FieldInputProps {
  readonly field: FieldInputSpec;
  readonly draft: Draft;
  readonly onChange: (next: Draft) => void;
  readonly onSubmit?: () => void;
  readonly onClearDate?: (() => void) | null;
  readonly inlineDate?: boolean;
  readonly autoFocus?: boolean;
  readonly disabled?: boolean;
  readonly error?: string | null;
  readonly relationLabels?: Readonly<Record<string, string>>;
  readonly onPickRelation?: () => void;
  readonly attachmentName?: string | null;
  readonly uploadingAttachment?: boolean;
  readonly onPickAttachment?: () => void;
  readonly onClearAttachment?: (() => void) | null;
  readonly onOpenAttachment?: (() => void) | null;
  readonly onRetryAttachment?: (() => void) | null;
}

export function FieldInput(props: FieldInputProps) {
  const { field, draft, onChange, error, disabled = false } = props;
  const theme = useTheme();
  let control;
  if (field.type === "checkbox")
    control = (
      <View style={[styles.row, { borderColor: theme.line }]}>
        <Text style={[styles.text, { color: theme.ink }]}>{field.name}</Text>
        <Switch
          value={draft === true}
          onValueChange={onChange}
          disabled={disabled}
          accessibilityLabel={field.name}
          trackColor={{ true: theme.accent }}
        />
      </View>
    );
  else if (field.type === "date")
    control = (
      <DateInput
        name={field.name}
        day={typeof draft === "string" ? draft : ""}
        inline={props.inlineDate === true}
        disabled={disabled}
        onPick={onChange}
        onClear={disabled ? null : (props.onClearDate ?? null)}
      />
    );
  else if (field.type === "select" || field.type === "multi-select") {
    const chosen = Array.isArray(draft) ? (draft as readonly string[]) : [];
    const many = field.type === "multi-select";
    control = (field.options ?? []).map((option) => {
      const on = chosen.includes(option);
      return (
        <Pressable
          key={option}
          disabled={disabled}
          onPress={() => {
            void Haptics.selectionAsync();
            onChange(
              on ? chosen.filter((x) => x !== option) : many ? [...chosen, option] : [option],
            );
          }}
          android_ripple={ripple(theme)}
          style={({ pressed }) => [
            styles.row,
            { borderColor: theme.line },
            pressed && { backgroundColor: theme.panel2 },
          ]}
          accessibilityRole={many ? "checkbox" : "radio"}
          accessibilityState={many ? { checked: on, disabled } : { selected: on, disabled }}
        >
          <Text style={[styles.text, { color: disabled ? theme.muted : theme.ink }]}>{option}</Text>
          {on ? <Check size={20} color={theme.accent} strokeWidth={2} /> : null}
        </Pressable>
      );
    });
  } else if (field.type === "relation") {
    const selected = Array.isArray(draft) ? (draft as readonly RecordId[]) : [];
    const summary = selected
      .map((k) => props.relationLabels?.[JSON.stringify(k)] ?? String(k))
      .join(", ");
    const placeholder = field.relation?.many
      ? collectionWords.chooseRecords
      : collectionWords.chooseRecord;
    control = (
      <Pressable
        onPress={props.onPickRelation}
        disabled={disabled || !props.onPickRelation}
        android_ripple={ripple(theme)}
        style={({ pressed }) => [
          styles.row,
          { borderColor: theme.line },
          pressed && { backgroundColor: theme.panel2 },
        ]}
        accessibilityRole="button"
        accessibilityState={{ disabled: disabled || !props.onPickRelation }}
        accessibilityLabel={`${field.name}, ${summary || placeholder}`}
      >
        <Text
          style={[styles.text, { color: summary && !disabled ? theme.ink : theme.subtle }]}
          numberOfLines={2}
        >
          {summary || placeholder}
        </Text>
        <ChevronRight size={18} color={theme.subtle} strokeWidth={2} />
      </Pressable>
    );
  } else if (field.type === "attachment") {
    const fileId = typeof draft === "string" ? draft.trim() : "";
    const busy = props.uploadingAttachment === true;
    const shownName = props.attachmentName ?? (fileId ? collectionWords.attachedFile : null);
    control = (
      <>
        {fileId ? (
          <Pressable
            disabled={!props.onOpenAttachment}
            onPress={props.onOpenAttachment ?? undefined}
            android_ripple={ripple(theme)}
            style={[styles.row, { borderColor: theme.line }]}
            accessibilityRole={props.onOpenAttachment ? "button" : "text"}
            accessibilityLabel={shownName ?? collectionWords.attachedFile}
          >
            <Paperclip size={18} color={theme.accent} strokeWidth={2} />
            <Text
              style={[
                styles.text,
                { flex: 1, color: props.onOpenAttachment ? theme.accent : theme.ink },
              ]}
              numberOfLines={1}
            >
              {shownName}
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          disabled={disabled || busy || !props.onPickAttachment}
          onPress={props.onPickAttachment}
          android_ripple={ripple(theme)}
          style={[styles.row, { borderColor: theme.line }]}
          accessibilityRole="button"
        >
          <Text style={[styles.text, { color: disabled || busy ? theme.subtle : theme.accent }]}>
            {busy
              ? collectionWords.uploadingAttachment
              : fileId
                ? collectionWords.replaceFile
                : collectionWords.chooseFile}
          </Text>
          {busy ? <ActivityIndicator size="small" /> : null}
        </Pressable>
        {fileId && props.onClearAttachment && !disabled && !busy ? (
          <Pressable
            onPress={props.onClearAttachment}
            android_ripple={ripple(theme)}
            style={[styles.row, { borderColor: theme.line }]}
            accessibilityRole="button"
          >
            <Text style={[styles.text, { color: theme.danger }]}>{collectionWords.clearValue}</Text>
          </Pressable>
        ) : null}
      </>
    );
  } else
    control = (
      <TextInput
        value={typeof draft === "string" ? draft : ""}
        onChangeText={onChange}
        editable={!disabled}
        autoFocus={props.autoFocus}
        multiline={field.type === "text"}
        keyboardType={
          field.type === "number"
            ? "numbers-and-punctuation"
            : field.type === "url"
              ? "url"
              : "default"
        }
        autoCapitalize={field.type === "text" ? "sentences" : "none"}
        autoCorrect={field.type === "text"}
        returnKeyType={field.type === "text" ? "default" : "done"}
        onSubmitEditing={field.type === "text" ? undefined : props.onSubmit}
        accessibilityLabel={field.name}
        style={[
          styles.input,
          field.type === "text" && styles.multiline,
          {
            color: disabled ? theme.muted : theme.ink,
            borderColor: error ? theme.danger : theme.line,
          },
        ]}
      />
    );
  return (
    <View style={styles.wrap}>
      {control}
      {error ? (
        <Text style={[styles.error, { color: theme.danger }]} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      {props.onRetryAttachment ? (
        <ActionPill
          label={noticesWords.tryAgain}
          onPress={props.onRetryAttachment}
          disabled={disabled}
        />
      ) : null}
    </View>
  );
}

function DateInput(props: {
  name: string;
  day: string;
  inline: boolean;
  disabled: boolean;
  onPick(day: string): void;
  onClear: (() => void) | null;
}) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(props.inline);
  const value = dateOf(props.day) ?? new Date();
  const pick = (_: unknown, picked: Date) => props.onPick(dayOf(picked));
  const openDialog = () => DateTimePickerAndroid.open({ value, mode: "date", onValueChange: pick });
  useEffect(() => {
    if (props.inline && Platform.OS === "android") openDialog();
  }, []);
  const formatted = props.day
    ? rowText(shownValue({ type: "date" }, props.day, {}), props.name)
    : null;
  const showInline =
    Platform.OS === "ios" && !props.disabled && (props.inline || (expanded && Boolean(props.day)));
  return (
    <>
      {showInline ? (
        <DateTimePicker
          value={value}
          mode="date"
          display="inline"
          accentColor={theme.accent}
          onValueChange={pick}
          accessibilityLabel={props.name}
        />
      ) : (
        <Pressable
          disabled={props.disabled}
          onPress={() => {
            if (Platform.OS === "android") openDialog();
            else {
              if (!props.day) props.onPick(dayOf(new Date()));
              setExpanded(true);
            }
          }}
          android_ripple={ripple(theme)}
          style={[styles.row, { borderColor: theme.line }]}
          accessibilityRole="button"
          accessibilityState={{ disabled: props.disabled }}
          accessibilityLabel={props.name}
        >
          <Text
            style={[
              styles.text,
              { color: formatted && !props.disabled ? theme.ink : theme.subtle },
            ]}
          >
            {formatted ?? collectionWords.chooseDate}
          </Text>
        </Pressable>
      )}
      {props.onClear && props.day ? (
        <Pressable
          onPress={() => {
            if (!props.inline) setExpanded(false);
            props.onClear?.();
          }}
          android_ripple={ripple(theme)}
          style={[styles.row, { borderColor: theme.line }]}
          accessibilityRole="button"
        >
          <Text style={[styles.text, { color: theme.accent }]}>{collectionWords.clearValue}</Text>
        </Pressable>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 4 },
  row: {
    minHeight: TOUCH,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  text: { fontSize: 17, flexShrink: 1 },
  input: {
    minHeight: TOUCH,
    fontSize: 17,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  multiline: { minHeight: 96, textAlignVertical: "top" },
  error: { fontSize: 14, lineHeight: 19 },
});
