import { confirmWords } from "@dohc/interface-words/confirmations";
import { chatWords } from "@dohc/interface-words/notices";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { ProblemLine } from "../account/ProblemLine";
import { confirm } from "../confirm";
import { ActionPill } from "../notices/ActionPill";
import type { Outbox } from "../server/outbox";
import { useTheme } from "../theme";

// A damaged kept.db stays until the person deletes it: nothing replaces a damaged file on its own. A failed delete says
// so in place, with Try again, which repeats the delete already confirmed, unless `live` says the screen has moved on.
export function DamagedKept(props: { outbox: Outbox; live(): boolean; onDeleted?(): void }) {
  const theme = useTheme();
  const [failed, setFailed] = useState(false);
  const remove = () => {
    setFailed(false);
    props.outbox.deleteDamaged().then(props.onDeleted, () => {
      if (props.live()) setFailed(true);
    });
  };
  const ask = async () => {
    const title = chatWords.deleteDamagedTitle;
    const message = chatWords.deleteDamagedBody;
    const label = chatWords.deleteDamagedConfirm;
    if (await confirm({ title, message, confirm: label, destructive: true })) remove();
  };
  return (
    <View>
      <Text style={[styles.text, { color: theme.muted }]}>{chatWords.outboxDamaged}</Text>
      <View style={styles.actions}>
        <ActionPill label={confirmWords.delete} onPress={() => void ask()} />
      </View>
      {failed ? <ProblemLine text={chatWords.deleteDamagedFailed} onRetry={remove} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  text: { fontSize: 17, lineHeight: 22 },
  actions: { flexDirection: "row", paddingTop: 8 },
});
