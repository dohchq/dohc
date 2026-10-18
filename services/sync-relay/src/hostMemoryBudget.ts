const MiB = 1024 * 1024;

/** Admission charges per unit of hosted work. Round 7 calibrates them. */
export type HostMemoryCoefficients = {
  workspaceBytes: number;
  documentBaseBytes: number;
  documentBytesPerEncodedByte: number;
  temporaryMinimumBytes: number;
  temporaryBytesPerInputByte: number;
};

/** The starting values, held in one place until calibration replaces them. */
export const HOST_MEMORY_DEFAULTS = Object.freeze({
  /** The budget when neither the setting nor a container limit names one. */
  fallbackBudgetBytes: 1024 * MiB,
  baselineBytes: 256 * MiB,
  coefficients: Object.freeze({workspaceBytes: 8 * MiB, documentBaseBytes: 8 * MiB, documentBytesPerEncodedByte: 32,
    temporaryMinimumBytes: 16 * MiB, temporaryBytesPerInputByte: 32}) satisfies HostMemoryCoefficients,
});

const SETTING = "DOHC_RELAY_HOST_MEMORY_BUDGET_MIB";
const MIN_SETTING_MIB = 512, MAX_SETTING_MIB = Math.floor(Number.MAX_SAFE_INTEGER / MiB);

/** Reads the operator's budget in MiB and returns it in bytes, or undefined when it is not set. */
export function readHostMemoryBudgetSetting(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const mib = /^[1-9]\d*$/u.test(value) ? Number(value) : NaN;
  if (!(mib >= MIN_SETTING_MIB && mib <= MAX_SETTING_MIB)) {
    throw new Error(`${SETTING} must be a whole number of MiB from ${MIN_SETTING_MIB} to ${MAX_SETTING_MIB}, got "${value}".`);
  }
  return mib * MiB;
}

export type HostMemoryBudgetSource = "setting" | "cgroup" | "fallback";

/** The setting, lowered to the container's memory limit when that is smaller. */
export function resolveHostMemoryBudget(settingBytes: number | undefined, cgroupLimitBytes: number | undefined): {bytes: number; source: HostMemoryBudgetSource} {
  if (cgroupLimitBytes !== undefined && (settingBytes === undefined || cgroupLimitBytes < settingBytes)) return {bytes: cgroupLimitBytes, source: "cgroup"};
  if (settingBytes !== undefined) return {bytes: settingBytes, source: "setting"};
  return {bytes: HOST_MEMORY_DEFAULTS.fallbackBudgetBytes, source: "fallback"};
}

export type HostMemoryWorkspace = {workspaceId: string; replicationEpoch: string | null; streamIdentity: string | null};
export type HostMemoryDocument = HostMemoryWorkspace & {objectId: string};
type Refusal = {ok: false; reason: "host-memory-full"};
export type HostMemoryAdmission = {ok: true} | Refusal;
export type HostMemoryTemporaryAdmission = {ok: true; reservation: HostMemoryTemporary} | Refusal;
export interface HostMemoryTemporary {
  /** Releases the charge. Call it only once the work has finished. */
  finished(): void;
}

export type HostMemorySnapshot = Readonly<{
  effectiveBytes: number; baselineBytes: number; headroomBytes: number;
  residentBytes: number; temporaryBytes: number; borrowedBytes: number;
  workspaces: number; documents: number; temporaryReservations: number; borrowedReservations: number;
  durabilityLaneHeld: boolean;
}>;

type Kind = "workspace" | "document" | "temporary";
type Charge = {readonly kind: Kind; bytes: number; lease: Lease | undefined; editors: boolean};
type Lease = {readonly engine: Engine; readonly charges: Set<Charge>; ended: boolean};
type Engine = {
  readonly workspaces: Map<string, Charge>;
  readonly documents: Map<string, {workspace: string; charge: Charge}>;
  readonly temporary: Set<Charge>;
  exited: boolean;
};

const REFUSED: Refusal = Object.freeze({ok: false, reason: "host-memory-full"});
const GRANTED = Object.freeze({ok: true} as const);
const workspaceKey = (row: HostMemoryWorkspace) => JSON.stringify([row.workspaceId, row.replicationEpoch, row.streamIdentity]);
const documentKey = (row: HostMemoryDocument) => JSON.stringify([row.workspaceId, row.replicationEpoch, row.streamIdentity, row.objectId]);
function byteCount(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer.`);
  return value;
}

/**
 * Admits hosted work against reserved memory, never measured memory. Every
 * call is synchronous, so callers cannot interleave inside one admission.
 * Ordinary work fits under the budget less its headroom. One durability
 * operation at a time may borrow the headroom.
 */
export function createHostMemoryBudget(options: {effectiveBytes: number; baselineBytes: number; coefficients?: HostMemoryCoefficients}) {
  const effectiveBytes = byteCount(options.effectiveBytes, "Effective budget");
  const baselineBytes = byteCount(options.baselineBytes, "Baseline");
  const coefficients = options.coefficients ?? HOST_MEMORY_DEFAULTS.coefficients;
  for (const name of ["workspaceBytes", "documentBaseBytes", "temporaryMinimumBytes"] as const) byteCount(coefficients[name], name);
  for (const name of ["documentBytesPerEncodedByte", "temporaryBytesPerInputByte"] as const) {
    if (!Number.isFinite(coefficients[name]) || coefficients[name] < 0) throw new RangeError(`${name} must be a non-negative number.`);
  }
  const headroomBytes = Math.floor(effectiveBytes / 4);
  const totals: Record<Kind, {bytes: number; count: number}> = {workspace: {bytes: 0, count: 0}, document: {bytes: 0, count: 0}, temporary: {bytes: 0, count: 0}};
  let lane: Lease | undefined;

  const fits = (request: number, lease: Lease | undefined) =>
    baselineBytes + totals.workspace.bytes + totals.document.bytes + totals.temporary.bytes + request + (lease ? 0 : headroomBytes) <= effectiveBytes;
  function charge(kind: Kind, bytes: number, lease: Lease | undefined): Charge | undefined {
    if (!fits(bytes, lease)) return undefined;
    const created: Charge = {kind, bytes, lease, editors: true};
    totals[kind].bytes += bytes; totals[kind].count++;
    lease?.charges.add(created);
    return created;
  }
  // A charge keeps its high-water mark. Growth through a lease moves the whole charge into it.
  function grow(existing: Charge, bytes: number, lease: Lease | undefined) {
    if (bytes > existing.bytes) {
      if (!fits(bytes - existing.bytes, lease)) return false;
      totals[existing.kind].bytes += bytes - existing.bytes; existing.bytes = bytes;
      if (lease) {existing.lease = lease; lease.charges.add(existing);}
    }
    return true;
  }
  function settle(lease: Lease) {
    if (lane === lease && lease.ended && lease.charges.size === 0) lane = undefined;
  }
  // Callers remove the charge from its owner first, so each charge is released once.
  function release(released: Charge) {
    totals[released.kind].bytes -= released.bytes; totals[released.kind].count--;
    if (released.lease) {released.lease.charges.delete(released); settle(released.lease);}
  }
  const documentBytes = (encodedInputBytes: number) =>
    Math.ceil((coefficients.documentBaseBytes + coefficients.documentBytesPerEncodedByte * byteCount(encodedInputBytes, "Encoded input")) / MiB) * MiB;
  const temporaryBytes = (inputBytes: number) =>
    Math.max(coefficients.temporaryMinimumBytes, Math.ceil(coefficients.temporaryBytesPerInputByte * byteCount(inputBytes, "Input")));

  function reservations(engine: Engine, lease: Lease | undefined) {
    const live = () => {
      if (engine.exited) throw new Error("This engine incarnation has exited.");
      if (lease?.ended) throw new Error("This durability operation has ended.");
    };
    return {
      /** Charges a workspace's overhead before it attaches. */
      attachWorkspace(workspace: HostMemoryWorkspace): HostMemoryAdmission {
        live();
        const key = workspaceKey(workspace);
        if (engine.workspaces.has(key)) return GRANTED;
        const created = charge("workspace", coefficients.workspaceBytes, lease);
        if (!created) return REFUSED;
        engine.workspaces.set(key, created);
        return GRANTED;
      },
      /** Charges a document before its first load, and grows the charge before new input is decoded. */
      reserveDocument(document: HostMemoryDocument, encodedInputBytes: number, flags?: {editors: boolean}): HostMemoryAdmission {
        live();
        const workspace = workspaceKey(document), key = documentKey(document), bytes = documentBytes(encodedInputBytes);
        if (!engine.workspaces.has(workspace)) throw new Error("Attach the workspace before loading its documents.");
        const existing = engine.documents.get(key)?.charge;
        const reserved = existing ? (grow(existing, bytes, lease) ? existing : undefined) : charge("document", bytes, lease);
        if (!reserved) return REFUSED;
        if (!existing) engine.documents.set(key, {workspace, charge: reserved});
        if (lease && reserved.lease === lease && flags?.editors === false) reserved.editors = false;
        return GRANTED;
      },
      /** Charges work such as validation or decoding until it has finished. */
      reserveTemporary(inputBytes: number): HostMemoryTemporaryAdmission {
        live();
        const created = charge("temporary", temporaryBytes(inputBytes), lease);
        if (!created) return REFUSED;
        engine.temporary.add(created);
        return {ok: true, reservation: {finished() {if (engine.temporary.delete(created)) release(created);}}};
      },
    };
  }

  return {
    effectiveBytes, baselineBytes, headroomBytes,
    /** Starts charging a new engine process. It owns no earlier incarnation's charges. */
    startEngine() {
      const engine: Engine = {workspaces: new Map(), documents: new Map(), temporary: new Set(), exited: false};
      const ordinary = reservations(engine, undefined);
      const unload = (key: string) => {
        const loaded = engine.documents.get(key);
        if (loaded && engine.documents.delete(key)) release(loaded.charge);
      };
      return {
        ...ordinary,
        /** Releases a document's charge once the engine confirmed its unload. */
        confirmUnload(document: HostMemoryDocument) {unload(documentKey(document));},
        /** Releases a workspace's charge, and its documents', once the engine confirmed its detach. */
        confirmDetach(workspace: HostMemoryWorkspace) {
          const key = workspaceKey(workspace), attached = engine.workspaces.get(key);
          for (const [loadedKey, loaded] of engine.documents) if (loaded.workspace === key) unload(loadedKey);
          if (attached && engine.workspaces.delete(key)) release(attached);
        },
        /** Whether a durability operation loaded this document on condition that it acquires no editors. */
        editorsBarred(document: HostMemoryDocument) {return engine.documents.get(documentKey(document))?.charge.editors === false;},
        /**
         * Lends the headroom to one durability operation: recovering or settling
         * accepted content, registering a retained source for an accepted restore,
         * or publishing and unloading during departure or retirement. The lane
         * stays held until the operation ends and its charges are released or transferred.
         */
        borrowDurability(): {ok: true; lease: ReturnType<typeof durability>} | Refusal {
          if (engine.exited) throw new Error("This engine incarnation has exited.");
          if (lane) return REFUSED;
          lane = {engine, charges: new Set(), ended: false};
          return {ok: true, lease: durability(lane)};
        },
        /** Releases every charge of this incarnation once its process has exited. */
        exited() {
          if (engine.exited) return;
          engine.exited = true;
          if (lane?.engine === engine) lane.ended = true;
          for (const key of [...engine.documents.keys()]) unload(key);
          for (const [key, attached] of [...engine.workspaces]) if (engine.workspaces.delete(key)) release(attached);
          for (const held of [...engine.temporary]) if (engine.temporary.delete(held)) release(held);
          if (lane?.engine === engine) settle(lane);
        },
      };
    },
    snapshot(): HostMemorySnapshot {
      let borrowedBytes = 0;
      for (const held of lane?.charges ?? []) borrowedBytes += held.bytes;
      return Object.freeze({effectiveBytes, baselineBytes, headroomBytes,
        residentBytes: totals.workspace.bytes + totals.document.bytes, temporaryBytes: totals.temporary.bytes, borrowedBytes,
        workspaces: totals.workspace.count, documents: totals.document.count, temporaryReservations: totals.temporary.count,
        borrowedReservations: lane?.charges.size ?? 0, durabilityLaneHeld: lane !== undefined});
    },
  };

  function durability(lease: Lease) {
    return {
      ...reservations(lease.engine, lease),
      /** Moves every borrowed charge to ordinary reservations when they fit without the headroom, and ends the operation. */
      transfer(): boolean {
        if (lane !== lease || !fits(0, undefined)) return false;
        for (const held of lease.charges) {held.lease = undefined; held.editors = true;}
        lease.charges.clear(); lease.ended = true; lane = undefined;
        return true;
      },
      /** Ends the operation. The lane stays held until its charges are released or transferred. */
      end() {lease.ended = true; settle(lease);},
    };
  }
}

export type HostMemoryBudget = ReturnType<typeof createHostMemoryBudget>;
export type HostEngineMemory = ReturnType<HostMemoryBudget["startEngine"]>;
