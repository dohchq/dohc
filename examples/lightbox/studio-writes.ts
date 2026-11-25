import { useEffect, useRef, useState } from "react";
import { useApp } from "dohc/app";
import { errorMessage, invoke, refusalCode, type ColorLabel, type Loaded, type StudioAsset } from "./portal/api";
import { useToast } from "./portal/toast";
import { BATCH, LABEL_TITLES, names, plural } from "./studio-parts";

const WRITABLE = ["rating", "colorLabel", "published"] as const;

function describe(next: Partial<StudioAsset>): string {
  if (next.rating !== undefined) return next.rating ? `the ${next.rating}-star rating` : "the cleared rating";
  if (next.colorLabel !== undefined) return next.colorLabel === "none" ? "the cleared label" : `the ${LABEL_TITLES[next.colorLabel].toLowerCase()} label`;
  return next.published ? "publishing" : "hiding";
}

function overlay(asset: StudioAsset, values: ReadonlyMap<string, unknown>): StudioAsset {
  let out = asset;
  for (const key of WRITABLE) {
    const field = `${asset.id}:${key}`;
    if (values.has(field)) out = { ...out, [key]: values.get(field) };
  }
  return out;
}

interface WriteHooks {
  flash(text: string, undo?: boolean): void;
  onSaved(): void;
  beforeChange(list: readonly StudioAsset[], next: Partial<StudioAsset>): void;
}

export function useAssetWrites({ assets, ...current }: WriteHooks & { assets: Loaded<StudioAsset[]> }) {
  const client = useApp();
  const toast = useToast();
  const [saving, setSaving] = useState(0);
  const undoStack = useRef<Array<() => boolean>>([]);
  const fieldVersions = useRef(new Map<string, number>());
  const writeQueues = useRef(new Map<string, Promise<unknown>>());
  const confirmed = useRef(new Map<string, unknown>());
  const desired = useRef(new Map<string, unknown>());
  const liveAssets = useRef<readonly StudioAsset[]>([]);
  const retries = useRef(new Set<() => void>());
  const hooks = useRef<WriteHooks>(current);
  hooks.current = current;
  const flash: WriteHooks["flash"] = (text, undo) => hooks.current.flash(text, undo);

  const loaded = assets.data ?? [];
  const all = desired.current.size ? loaded.map((asset) => overlay(asset, desired.current)) : loaded;
  liveAssets.current = all;

  useEffect(() => {
    const open = retries.current;
    return () => {
      for (const dismiss of open) dismiss();
    };
  }, []);

  const undoLast = () => {
    while (undoStack.current.length) if (undoStack.current.pop()!()) return;
    flash("Nothing to undo");
  };

  const patch = (changes: ReadonlyMap<string, Partial<StudioAsset>>) =>
    assets.replace((list) => list.map((asset) => (changes.has(asset.id) ? { ...asset, ...changes.get(asset.id) } : asset)));

  const change = async (
    list: readonly StudioAsset[],
    next: Partial<StudioAsset>,
    operation: string,
    done: string,
    undoFor: ((subset: readonly StudioAsset[]) => () => boolean) | null,
  ) => {
    const keys = Object.keys(next) as Array<keyof StudioAsset>;
    const before = new Map<string, unknown>();
    const saved = new Set<string>();
    const undoOf = (subset: readonly StudioAsset[]) =>
      undoFor
        ? () => {
            const live = new Set(liveAssets.current.map((asset) => asset.id));
            if (!subset.some((asset) => live.has(asset.id))) return false;
            const pressed = new Map(subset.flatMap((asset) => keys.map((key) => [`${asset.id}:${key}`, fieldVersions.current.get(`${asset.id}:${key}`)])));
            const untouched = (field: string) => before.has(field) && fieldVersions.current.get(field) === pressed.get(field);
            void Promise.all(writes).then(() => {
              const prior = subset.flatMap((asset) =>
                saved.has(asset.id) && keys.every((key) => untouched(`${asset.id}:${key}`))
                  ? [{ ...asset, ...Object.fromEntries(keys.map((key) => [key, before.get(`${asset.id}:${key}`)])) }]
                  : [],
              );
              if (prior.length) undoFor(prior)();
            });
            return true;
          }
        : null;
    const undo = undoOf(list);
    const live = new Map(liveAssets.current.map((asset) => [asset.id, asset]));
    const stamps = list.flatMap((asset) =>
      keys.map((key) => {
        const field = `${asset.id}:${key}`;
        const version = (fieldVersions.current.get(field) ?? 0) + 1;
        fieldVersions.current.set(field, version);
        if (!confirmed.current.has(field)) confirmed.current.set(field, (live.get(asset.id) ?? asset)[key]);
        desired.current.set(field, next[key]);
        return { assetId: asset.id, key, field, version };
      }),
    );
    type Stamp = (typeof stamps)[number];
    const isLatest = (stamp: Stamp) => fieldVersions.current.get(stamp.field) === stamp.version;
    const apply = (ids: ReadonlySet<string>, value: (stamp: Stamp) => unknown) => {
      const changes = new Map<string, Partial<StudioAsset>>();
      for (const stamp of stamps)
        if (ids.has(stamp.assetId) && isLatest(stamp)) changes.set(stamp.assetId, { ...changes.get(stamp.assetId), [stamp.key]: value(stamp) });
      if (changes.size) patch(changes);
    };
    const ids = list.map((asset) => asset.id);
    hooks.current.beforeChange(list, next);
    const failed = new Map<string, unknown>();
    let previous: Promise<unknown> = Promise.resolve();
    const writes = Array.from({ length: Math.ceil(ids.length / BATCH) }, (_, index) => {
      const chunk = ids.slice(index * BATCH, (index + 1) * BATCH);
      const settled = Promise.all([previous, ...chunk.map((id) => writeQueues.current.get(id))])
        .then(async () => {
          const sent = new Set(chunk.filter((id) => stamps.some((stamp) => stamp.assetId === id && isLatest(stamp))));
          for (const stamp of stamps) if (sent.has(stamp.assetId)) before.set(stamp.field, confirmed.current.get(stamp.field));
          if (sent.size) await invoke(client, operation, { assetIds: [...sent], ...next });
          for (const id of sent) saved.add(id);
          for (const stamp of stamps) if (sent.has(stamp.assetId)) confirmed.current.set(stamp.field, next[stamp.key]);
        })
        .catch((error: unknown) => {
          for (const id of chunk) failed.set(id, error);
        });
      previous = settled;
      for (const id of chunk) writeQueues.current.set(id, settled);
      void settled.then(() => {
        for (const id of chunk) if (writeQueues.current.get(id) === settled) writeQueues.current.delete(id);
      });
      return settled;
    });
    apply(new Set(ids), (stamp) => next[stamp.key]);
    flash(done, Boolean(undo));
    if (undo) undoStack.current = [...undoStack.current.slice(-49), undo];
    setSaving((count) => count + 1);
    await Promise.all(writes);
    setSaving((count) => count - 1);
    apply(
      new Set(ids.filter((id) => !failed.has(id))),
      (stamp) => next[stamp.key],
    );
    const kept = list.filter((asset) => saved.has(asset.id));
    if (undo && kept.length < list.length) {
      const partial = kept.length ? undoOf(kept) : null;
      undoStack.current = undoStack.current.flatMap((step) => (step !== undo ? [step] : partial ? [partial] : []));
    }
    if (failed.size) {
      for (const stamp of stamps) if (failed.has(stamp.assetId) && isLatest(stamp)) desired.current.delete(stamp.field);
      apply(new Set(failed.keys()), (stamp) => confirmed.current.get(stamp.field));
      const lostIds = new Set(stamps.filter((stamp) => failed.has(stamp.assetId) && isLatest(stamp)).map((stamp) => stamp.assetId));
      const lost = list.filter((asset) => lostIds.has(asset.id));
      const again = lost.filter((asset) => !refusalCode(failed.get(asset.id)));
      const retryStamps = stamps.filter((stamp) => again.some((asset) => asset.id === stamp.assetId));
      if (lost.length) {
        const dismiss = toast(`Could not save ${describe(next)} on ${names(lost)}. ${errorMessage(failed.get(lost[0]!.id))}`, {
          tone: "danger",
          retry: again.length
            ? () => {
                retries.current.delete(dismiss);
                if (retryStamps.every(isLatest)) void change(again, next, operation, done, undoFor);
                else flash("A newer change replaced this one");
              }
            : undefined,
        });
        retries.current.add(dismiss);
      }
    }
    if (failed.size < ids.length) hooks.current.onSaved();
    for (const stamp of stamps)
      if (isLatest(stamp)) {
        confirmed.current.delete(stamp.field);
        desired.current.delete(stamp.field);
      }
  };

  const restore =
    <K extends keyof StudioAsset>(list: readonly StudioAsset[], key: K, what: string, run: (group: StudioAsset[], value: StudioAsset[K]) => void) =>
    () => {
      const live = new Set(liveAssets.current.map((asset) => asset.id));
      const kept = list.filter((asset) => live.has(asset.id));
      if (!kept.length) return false;
      const groups = new Map<StudioAsset[K], StudioAsset[]>();
      for (const asset of kept) groups.set(asset[key], [...(groups.get(asset[key]) ?? []), asset]);
      for (const [value, group] of groups) run(group, value);
      flash(`${what[0]!.toUpperCase()}${what.slice(1)} on ${names(kept)} undone`);
      return true;
    };

  const rate = (list: readonly StudioAsset[], rating: number, undoing = false): Promise<void> =>
    change(
      list,
      { rating },
      "setOwnerRating",
      undoing ? `Rating on ${names(list)} undone` : rating ? `${names(list)} rated ${plural(rating, "star")}` : `Rating cleared on ${names(list)}`,
      undoing ? null : (subset) => restore(subset, "rating", "rating", (group, value) => void rate(group.map((asset) => ({ ...asset, rating })), value, true)),
    );
  const label = (list: readonly StudioAsset[], colorLabel: ColorLabel, undoing = false): Promise<void> =>
    change(
      list,
      { colorLabel },
      "setColorLabel",
      undoing
        ? `Label on ${names(list)} undone`
        : colorLabel === "none"
          ? `Label cleared on ${names(list)}`
          : `${names(list)} labeled ${LABEL_TITLES[colorLabel].toLowerCase()}`,
      undoing ? null : (subset) => restore(subset, "colorLabel", "label", (group, value) => void label(group.map((asset) => ({ ...asset, colorLabel })), value, true)),
    );
  const publish = (list: readonly StudioAsset[], published = !list.every((asset) => asset.published), undoing = false): Promise<void> =>
    change(
      list,
      { published },
      "publishAsset",
      undoing ? `Publishing on ${names(list)} undone` : published ? `${names(list)} published to the client` : `${names(list)} hidden from the client`,
      undoing ? null : (subset) => restore(subset, "published", "publishing", (group, value) => void publish(group.map((asset) => ({ ...asset, published })), value, true)),
    );
  const toggleLabel = (list: readonly StudioAsset[], colorLabel: ColorLabel) =>
    label(list, list.every((asset) => asset.colorLabel === colorLabel) ? "none" : colorLabel);

  return { all, saving, rate, label, publish, toggleLabel, undoLast };
}
