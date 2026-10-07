import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DependencyList } from "react";
import { bridge } from "./bridge";
import { desktopMembers, type CommandName, type DataExecutor, type DataInput, type EventName, type EventValue, type InputOf, type ReadDesktop, type ReadName, type ResultOf } from "./desktopOperations";

type AnyRequest = string | ((desktop: never, input: never, context: never) => PromiseLike<unknown>);
type Transport = Record<string, (input: unknown) => PromiseLike<unknown>>;

declare const taskBrand: unique symbol;
export interface DesktopTask { readonly [taskBrand]: true }
// RA6 keeps completion access inside tests. Settlement means renderer delivery, not durable storage.
export const settledTasks = new WeakMap<DesktopTask, Promise<void>>();
const notIssued = {} as DesktopTask;
settledTasks.set(notIssued, Promise.resolve());

const readNames = Object.entries(desktopMembers).filter(([, member]) => member.kind === "read" && !("owner" in member)).map(([name]) => name);

export function desktopMetadata() {
  const { platform, devTools, windowRole } = bridge();
  return { platform, devTools, windowRole } as const;
}

export function getDroppedFilePaths(files: File[]): string[] {
  return bridge().getDroppedFilePaths(files);
}

function issue(work: (settle: () => void) => void): DesktopTask {
  const task = {} as DesktopTask;
  settledTasks.set(task, new Promise<void>((resolve) => work(resolve)));
  return task;
}

function guarded(run: () => void): void {
  try { run(); } catch (error) {
    // The root's installed global error reporter owns unexpected renderer failures.
    window.dispatchEvent(new ErrorEvent("error", { error, message: error instanceof Error ? error.message : String(error) }));
  }
}

function send(request: AnyRequest, input: unknown, context?: unknown): PromiseLike<unknown> {
  try {
    const api = bridge();
    if (typeof request === "string") return (api as unknown as Transport)[request]!(input);
    const reads = Object.fromEntries(readNames.map(name => [name, (api as unknown as Transport)[name]])) as unknown as ReadDesktop;
    return (request as (desktop: ReadDesktop, input: unknown, context: unknown) => PromiseLike<unknown>)(reads, structuredClone(input), structuredClone(context));
  } catch (error) { return Promise.reject(error); }
}

// Tagged data trees distinguish types, absent properties, and numeric special values.
function stableKey(value: unknown): string {
  function encode(v: unknown): unknown {
    if (v === undefined) return ["undefined"];
    if (v === null) return ["null"];
    if (typeof v === "number") return ["number", Number.isNaN(v) ? "NaN" : Object.is(v, -0) ? "-0" : String(v)];
    if (typeof v === "string" || typeof v === "boolean") return [typeof v, v];
    if (Array.isArray(v)) return ["array", Array.from(v, encode)];
    return ["object", Object.entries(v as object).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, item]) => [k, encode(item)])];
  }
  return JSON.stringify(encode(value));
}

interface Binding<P> { live: boolean; ticket: number; inFlight: number; published: P; owner: () => Binding<P> | null }

function useBinding<P>(identity: DependencyList, published: P) {
  const committed = useRef<Binding<P> | null>(null);
  const [, setVersion] = useState(0);
  // The selector is an identity token. Allocation and publication of its binding happen only at commit.
  const current: () => Binding<P> | null = useCallback(() => {
    const binding = committed.current;
    return binding?.owner === current ? binding : null;
  }, identity);
  useLayoutEffect(() => {
    const binding: Binding<P> = { live: true, ticket: 0, inFlight: 0, published, owner: current };
    committed.current = binding;
    return () => { binding.live = false; };
  }, [current]);
  useLayoutEffect(() => { const binding = current(); if (binding) binding.published = published; });
  const changed = useCallback(() => { if (current()?.live) setVersion(v => v + 1); }, [current]);
  return { current, changed, pending: (current()?.inFlight ?? 0) > 0 };
}

export interface Delivery<R> { success(value: R): void; failure(error: unknown): void }
type ReadPublication = { request: AnyRequest; delivery: Delivery<unknown>; input?: unknown; context?: unknown };

function useIssueRead(current: () => Binding<ReadPublication> | null, changed: () => void) {
  return useCallback((input: unknown): DesktopTask => {
    const binding = current();
    if (!binding?.live) return notIssued;
    const ticket = ++binding.ticket;
    const owns = () => binding.live && binding.ticket === ticket;
    binding.inFlight++;
    changed();
    return issue((settle) => {
      const done = (deliver: () => void) => {
        if (owns()) guarded(deliver);
        binding.inFlight--;
        changed();
        settle();
      };
      send(binding.published.request, input, binding.published.context).then(
        value => done(() => binding.published.delivery.success(value)),
        (error: unknown) => done(() => binding.published.delivery.failure(error)),
      );
    });
  }, [current, changed]);
}

// Only the newest call per binding delivers. Independent concurrent reads need one binding each.
export function useDesktopAction<K extends ReadName>(identity: DependencyList, request: K, delivery: Delivery<ResultOf<K>>): readonly [(input: InputOf<K>) => DesktopTask, boolean];
export function useDesktopAction<I, R>(identity: DependencyList, request: DataExecutor<I, R>, delivery: Delivery<R>): readonly [(input: DataInput<I>) => DesktopTask, boolean];
export function useDesktopAction(identity: DependencyList, request: AnyRequest, delivery: Delivery<unknown>): readonly [(input: unknown) => DesktopTask, boolean] {
  const { current, changed, pending } = useBinding<ReadPublication>(identity, { request, delivery });
  return [useIssueRead(current, changed), pending];
}

// Loads share the newest-call rule; concurrent independent reads need separate bindings.
// Read `pending` during render to re-render on its changes; a load that no render reads stays quiet.
export function useDesktopLoad<K extends ReadName>(identity: DependencyList, request: K, input: InputOf<K> | null, delivery: Delivery<ResultOf<K>>): { readonly pending: boolean };
export function useDesktopLoad<I, R, C = undefined>(identity: DependencyList, request: DataExecutor<I, R, C>, input: DataInput<I> | null, delivery: Delivery<R>, ...context: C extends undefined ? [] : [DataInput<C>]): { readonly pending: boolean };
export function useDesktopLoad(identity: DependencyList, request: AnyRequest, input: unknown, delivery: Delivery<unknown>, context?: unknown): { readonly pending: boolean } {
  const { current, changed, pending } = useBinding<ReadPublication>([...identity, stableKey(input)], { request, delivery, input, context });
  const observesPending = useRef(false);
  // Each render owns its observation; only a commit can change notifications for the live binding.
  // A pending change between this render and its commit sent no notification, so re-render here.
  let pendingRead = false;
  useLayoutEffect(() => {
    observesPending.current = pendingRead;
    if (pendingRead && pending !== ((current()?.inFlight ?? 0) > 0)) changed();
  });
  const changedIfObserved = useCallback(() => { if (observesPending.current) changed(); }, [changed]);
  const load = useIssueRead(current, changedIfObserved);
  useEffect(() => { const binding = current(); if (binding && binding.published.input !== null) load(binding.published.input); }, [current, load]);
  return { get pending() { pendingRead = true; return pending; } };
}

export interface OutcomeScope { readonly live: () => boolean }
export interface CommandOutcome<I, R, C = undefined> {
  readonly scope: OutcomeScope;
  success(result: R, input: I, context: C): void;
  failure(error: unknown, input: I, retry: () => void, context: C): void;
}
export interface ViewFollowUp<I, R> { success?(result: R, input: I): void; failure?(error: unknown, input: I): void }
type CommandPublication = { request: string; outcome: CommandOutcome<unknown, unknown, unknown>; view: ViewFollowUp<unknown, unknown> };

export function useDesktopCommand<K extends CommandName, C = undefined>(identity: DependencyList, request: K, outcome: CommandOutcome<InputOf<K>, ResultOf<K>, C>, view?: ViewFollowUp<InputOf<K>, ResultOf<K>>): readonly [(input: InputOf<K>, ...context: C extends undefined ? [] : [DataInput<C>]) => DesktopTask, boolean];
export function useDesktopCommand(identity: DependencyList, request: string, outcome: CommandOutcome<unknown, unknown, unknown>, view: ViewFollowUp<unknown, unknown> = {}): readonly [(input: unknown, context?: unknown) => DesktopTask, boolean] {
  const { current, changed, pending } = useBinding<CommandPublication>(identity, { request, outcome, view });
  const issueCall = useCallback((binding: Binding<CommandPublication>, input: unknown, context: unknown, request: string, callOutcome: CommandOutcome<unknown, unknown, unknown>): DesktopTask => {
    let snapshot = input;
    let labels = context;
    binding.inFlight++;
    changed();
    return issue((settle) => {
      const done = (toScope: () => void, toView: (v: ViewFollowUp<unknown, unknown>) => void) => {
        if (callOutcome.scope.live()) guarded(toScope);
        if (binding.live) guarded(() => toView(binding.published.view));
        binding.inFlight--;
        changed();
        settle();
      };
      const retry = () => { if (callOutcome.scope.live()) issueCall(binding, snapshot, labels, request, callOutcome); };
      try {
        snapshot = structuredClone(input);
        labels = structuredClone(context);
      } catch (error) {
        done(() => callOutcome.failure(error, input, retry, context), v => v.failure?.(error, input));
        return;
      }
      send(request, snapshot).then(
        value => done(() => callOutcome.success(value, snapshot, labels), v => v.success?.(value, snapshot)),
        (error: unknown) => done(() => callOutcome.failure(error, snapshot, retry, labels), v => v.failure?.(error, snapshot)),
      );
    });
  }, [changed]);
  const run = useCallback((input: unknown, context?: unknown): DesktopTask => {
    const binding = current();
    if (!binding?.live) return notIssued;
    return issueCall(binding, input, context, binding.published.request, binding.published.outcome);
  }, [current, issueCall]);
  return [run, pending];
}

export function useDesktopEvent<E extends EventName>(identity: DependencyList, event: E, handler: (value: EventValue<E>) => void): void {
  const { current } = useBinding([...identity, event], { handler });
  useLayoutEffect(() => {
    const binding = current()!;
    const subscribe = bridge()[event] as (listener: (value: EventValue<E>) => void) => () => void;
    const unsubscribe = subscribe(value => { if (binding.live) guarded(() => binding.published.handler(value)); });
    return unsubscribe;
  }, [current]);
}
