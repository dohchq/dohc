import { useEffect, useState } from "react";
import { bridge } from "../bridge";
import { useWorkspaceQuery } from "../workspace/useWorkspaceQuery";
import { useWorkspaceSession } from "../workspace/workspaceSession";
import { SettingRow, SettingsSection, SwitchControl } from "./SettingRow";

/** The Owner's and Admins' switch that lets members share their Personal apps with the workspace. */
export function MemberAppSharingSetting(props: {
  workspaceId: string;
  onError?: (message: string, cause?: unknown, retry?: () => Promise<void>) => void;
}) {
  const { workspaceId, onError } = props;
  const session = useWorkspaceSession();
  const [chosen, setChosen] = useState<{ workspaceId: string; on: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const loaded = useWorkspaceQuery(session, {
    key: workspaceId,
    load: async () => (await bridge().memberAppsList({ workspaceId })).membersCanShare ?? null,
  });
  useEffect(() => {
    if (loaded.error)
      onError?.("dohc could not read who can share apps.", loaded.error, async () =>
        loaded.retry(),
      );
  }, [loaded.error]);
  const change = async (membersCanShare: boolean) => {
    setBusy(true);
    try {
      const result = await bridge().memberAppSharing({ workspaceId, membersCanShare });
      setChosen({ workspaceId, on: result.membersCanShare });
    } catch (cause) {
      onError?.("dohc could not change who can share apps.", cause, () => change(membersCanShare));
    } finally {
      setBusy(false);
    }
  };
  const on = chosen?.workspaceId === workspaceId ? chosen.on : loaded.value;
  if (typeof on !== "boolean") return null;
  return (
    <SettingsSection>
      <SettingRow
        title="Members can share apps"
        testId="settings-members-app-sharing"
        detail={
          <span className="-mr-4 ml-auto flex shrink-0 items-center gap-2">
            <SwitchControl
              label="Members can share apps"
              checked={on}
              busy={busy}
              disabled={busy}
              onChange={(next) => void change(next)}
            />
          </span>
        }
        description="Members share their Personal apps with everyone here. Turning it off pauses the apps members shared until you turn it on again."
      />
    </SettingsSection>
  );
}
