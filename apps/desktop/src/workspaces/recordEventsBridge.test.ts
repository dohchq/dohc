import type { Event, JsonValue } from "@dohc/workspace-engine-client";
import { describe, expect, it } from "vitest";
import type { PluginRecordEvent } from "../plugins/pluginWorkspaceEvents";
import {
  RECORD_CREATED_EVENT,
  RECORD_FIELD_CHANGED_EVENT,
  RECORD_UPDATED_EVENT,
  bridgeRecordEventsToPlugins,
} from "./recordEventsBridge";

function daemonEvent(name: string, payload: Event["payload"] = null): Event {
  return { seq: 1, sessionGeneration: 1, name, payload };
}

function changedPayload(workspaceId: string): { [key in string]?: JsonValue } {
  return {
    workspaceId,
    collectionPath: "collections/people",
    recordId: "rec-1",
    author: "agent:sites",
    timestamp: 1_756_000_000_000,
    actorKind: "agent",
    onBehalfOf: "user:ice",
    depth: 0,
    source: { originId: "origin-a", originSeq: 7 },
  };
}

function fieldChangedPayload(workspaceId: string): { [key in string]?: JsonValue } {
  return {
    ...changedPayload(workspaceId),
    field: "status",
    previous: null,
    next: { truncated: true, bytes: 9_000 },
    historyId: 41,
  };
}

function fakeDaemon(): {
  daemon: { onEvent(handler: (event: Event) => void): () => void };
  emit: (event: Event) => void;
  handlerCount: () => number;
} {
  const handlers = new Set<(event: Event) => void>();
  return {
    daemon: {
      onEvent(handler) {
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
        };
      },
    },
    emit: (event) => {
      for (const handler of handlers) handler(event);
    },
    handlerCount: () => handlers.size,
  };
}

function registries(): {
  registryFor: (
    workspaceId: string,
  ) => { handleRecordEvent(event: PluginRecordEvent): void } | undefined;
  received: Map<string, PluginRecordEvent[]>;
} {
  const received = new Map<string, PluginRecordEvent[]>();
  return {
    received,
    registryFor: (workspaceId) => {
      // Only known workspaces have a registry — an unknown id gets undefined,
      // exactly like pluginWorkspaceRuntimes.current for a closed workspace.
      if (workspaceId !== "ws-a" && workspaceId !== "ws-b") return undefined;
      return {
        handleRecordEvent: (event) => {
          const events = received.get(workspaceId) ?? [];
          events.push(event);
          received.set(workspaceId, events);
        },
      };
    },
  };
}

describe("bridgeRecordEventsToPlugins", () => {
  it("routes each valid event to the workspace registry the payload names", () => {
    const { daemon, emit } = fakeDaemon();
    const { registryFor, received } = registries();
    bridgeRecordEventsToPlugins(daemon, registryFor);

    emit(daemonEvent(RECORD_CREATED_EVENT, changedPayload("ws-a")));
    emit(daemonEvent(RECORD_UPDATED_EVENT, changedPayload("ws-b")));
    emit(daemonEvent(RECORD_FIELD_CHANGED_EVENT, fieldChangedPayload("ws-a")));

    expect(received.get("ws-a")).toEqual([
      {
        name: "record.created",
        data: {
          collectionPath: "collections/people",
          recordId: "rec-1",
          author: "agent:sites",
          timestamp: 1_756_000_000_000,
          actorKind: "agent",
          onBehalfOf: "user:ice",
          depth: 0,
          source: { originId: "origin-a", originSeq: 7 },
        },
      },
      {
        name: "record.field.changed",
        data: {
          collectionPath: "collections/people",
          recordId: "rec-1",
          field: "status",
          previous: null,
          next: { truncated: true, bytes: 9_000 },
          author: "agent:sites",
          timestamp: 1_756_000_000_000,
          historyId: 41,
          actorKind: "agent",
          onBehalfOf: "user:ice",
          depth: 0,
          source: { originId: "origin-a", originSeq: 7 },
        },
      },
    ]);
    expect(received.get("ws-b")).toEqual([
      {
        name: "record.updated",
        data: {
          collectionPath: "collections/people",
          recordId: "rec-1",
          author: "agent:sites",
          timestamp: 1_756_000_000_000,
          actorKind: "agent",
          onBehalfOf: "user:ice",
          depth: 0,
          source: { originId: "origin-a", originSeq: 7 },
        },
      },
    ]);
  });

  it("carries a null author through as null", () => {
    const { daemon, emit } = fakeDaemon();
    const { registryFor, received } = registries();
    bridgeRecordEventsToPlugins(daemon, registryFor);

    emit(
      daemonEvent(RECORD_CREATED_EVENT, {
        ...changedPayload("ws-a"),
        author: null,
      }),
    );

    expect(received.get("ws-a")).toEqual([
      {
        name: "record.created",
        data: {
          collectionPath: "collections/people",
          recordId: "rec-1",
          author: null,
          timestamp: 1_756_000_000_000,
          actorKind: "agent",
          onBehalfOf: "user:ice",
          depth: 0,
          source: { originId: "origin-a", originSeq: 7 },
        },
      },
    ]);
  });

  it("drops a payload that does not match the contract", () => {
    const { daemon, emit } = fakeDaemon();
    const { registryFor, received } = registries();
    bridgeRecordEventsToPlugins(daemon, registryFor);

    const invalidPayloads: Event["payload"][] = [
      null,
      "not-an-object",
      ["not", "a", "record"],
      { ...changedPayload("ws-a"), workspaceId: "" },
      { ...changedPayload("ws-a"), recordId: 7 },
      { ...changedPayload("ws-a"), collectionPath: null },
      { ...changedPayload("ws-a"), author: 12 },
      { ...changedPayload("ws-a"), timestamp: "yesterday" },
    ];
    for (const payload of invalidPayloads) {
      emit(daemonEvent(RECORD_CREATED_EVENT, payload));
    }
    // field.changed additionally requires field, historyId, and both values.
    emit(
      daemonEvent(RECORD_FIELD_CHANGED_EVENT, {
        ...changedPayload("ws-a"),
        historyId: 41,
        previous: null,
        next: 1,
      }),
    );
    const withoutNext = fieldChangedPayload("ws-a");
    delete withoutNext.next;
    emit(daemonEvent(RECORD_FIELD_CHANGED_EVENT, withoutNext));
    emit(
      daemonEvent(RECORD_FIELD_CHANGED_EVENT, {
        ...fieldChangedPayload("ws-a"),
        historyId: "41",
      }),
    );

    expect(received.size).toBe(0);
  });

  it("delivers nothing for a workspace without a registry", () => {
    const { daemon, emit } = fakeDaemon();
    const { registryFor, received } = registries();
    bridgeRecordEventsToPlugins(daemon, registryFor);

    emit(daemonEvent(RECORD_CREATED_EVENT, changedPayload("ws-closed")));

    expect(received.size).toBe(0);
  });

  it("ignores unrelated daemon events", () => {
    const { daemon, emit } = fakeDaemon();
    const { registryFor, received } = registries();
    bridgeRecordEventsToPlugins(daemon, registryFor);

    emit(daemonEvent("capture.momentRecorded", changedPayload("ws-a")));
    emit(daemonEvent("record.deleted", changedPayload("ws-a")));

    expect(received.size).toBe(0);
  });

  it("dispose unsubscribes from the daemon", () => {
    const { daemon, emit, handlerCount } = fakeDaemon();
    const { registryFor, received } = registries();
    const dispose = bridgeRecordEventsToPlugins(daemon, registryFor);

    dispose();
    expect(handlerCount()).toBe(0);
    emit(daemonEvent(RECORD_CREATED_EVENT, changedPayload("ws-a")));
    expect(received.size).toBe(0);
  });
});
