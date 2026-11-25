import { useState } from "react";
import { useApp } from "dohc/app";
import { readCameraSettings } from "./camera";
import {
  checkPhoto,
  errorMessage,
  invoke,
  refusalCode,
  uploadPhoto,
  type Loaded,
  type StudioAsset,
  type UploadedPhoto,
} from "./portal/api";
import { useToast } from "./portal/toast";

const uploadJobs = new WeakMap<File, { key: string; sent?: UploadedPhoto }>();

export function useUploads(shootId: string, assets: Loaded<StudioAsset[]>, onSaved: () => void) {
  const client = useApp();
  const toast = useToast();
  const [uploads, setUploads] = useState(0);
  const addFiles = async (files: readonly File[]) => {
    for (const file of files) {
      const problem = checkPhoto(file);
      if (problem) {
        toast(problem, { tone: "danger" });
        continue;
      }
      setUploads((count) => count + 1);
      const job = uploadJobs.get(file) ?? { key: crypto.randomUUID() };
      uploadJobs.set(file, job);
      try {
        const sent = (job.sent ??= await uploadPhoto(client, file, job.key));
        const capture = await readCameraSettings(file);
        const asset = await invoke<StudioAsset>(
          client,
          "uploadAsset",
          {
            shootId,
            fileId: sent.fileId,
            previewFileId: sent.previewFileId,
            ...(capture ? { capture } : {}),
            width: sent.width,
            height: sent.height,
          },
          `uploadAsset:${job.key}`,
        );
        uploadJobs.delete(file);
        assets.replace((list) =>
          list.some((item) => item.id === asset.id)
            ? list.map((item) => (item.id === asset.id ? asset : item))
            : [...list, asset],
        );
        toast(`Added ${asset.title} as a draft.`);
        onSaved();
      } catch (error) {
        toast(`${file.name}: ${errorMessage(error)}`, {
          tone: "danger",
          retry: refusalCode(error) ? undefined : () => void addFiles([file]),
        });
      } finally {
        setUploads((count) => count - 1);
      }
    }
  };

  return { uploads, addFiles };
}
