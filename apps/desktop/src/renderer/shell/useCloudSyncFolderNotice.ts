import { useCallback, useEffect } from "react";

export interface CloudSyncFolderNoticeState {
  service: string | null;
  acknowledged?: boolean;
}

export function cloudSyncFolderNotice(service: string | null): {
  title: string;
  message: string;
} {
  if (service) {
    return {
      title: `This workspace is inside ${service}`,
      message: `${service} can corrupt your workspace data when syncing across computers. Move this workspace to a local folder outside ${service}.`,
    };
  }
  return {
    title: "This workspace is in a cloud-synced folder",
    message:
      "Cloud sync can corrupt your workspace data across computers. Move this workspace to a local folder outside cloud sync.",
  };
}

const storageKey = (workspaceId: string) => `dohc:cloud-sync-folder-notice:${workspaceId}`;

const session = new Map<string, { dismissed: boolean }>();

export function forgetCloudSyncFolderNoticesForTests(): void {
  session.clear();
}

function toldBefore(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function rememberTold(key: string): void {
  try {
    localStorage.setItem(key, new Date().toISOString());
  } catch {
    // Refused storage tells the person again next launch.
  }
}

export function useCloudSyncFolderNotice(input: {
  workspaceId: string;
  cloudSyncFolder: CloudSyncFolderNoticeState | null | undefined;
  report: (notice: {
    title: string;
    message: string;
    service: string | null;
    toast: boolean;
  }) => void;
}): { noteDismissed: () => void } {
  const { workspaceId, cloudSyncFolder, report } = input;
  const detected = cloudSyncFolder !== null && cloudSyncFolder !== undefined;
  const service = cloudSyncFolder?.service ?? null;
  const acknowledged = cloudSyncFolder?.acknowledged === true;
  const key = storageKey(workspaceId);
  useEffect(() => {
    if (!detected) return;
    if (acknowledged) {
      rememberTold(key);
      session.set(key, { dismissed: true });
      return;
    }
    const told = session.get(key);
    if (told?.dismissed) return;
    if (!told) {
      if (toldBefore(key)) return;
      rememberTold(key);
      session.set(key, { dismissed: false });
    }
    report({ ...cloudSyncFolderNotice(service), service, toast: !told });
  }, [acknowledged, detected, key, report, service]);
  const noteDismissed = useCallback(() => {
    session.set(key, { dismissed: true });
  }, [key]);
  return { noteDismissed };
}
