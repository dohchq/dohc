import { z } from "zod";

const DRAWING_ELEMENT_TYPES = [
  "rectangle",
  "ellipse",
  "diamond",
  "text",
  "arrow",
  "line",
  "frame",
] as const;
const MAX_DRAWING_CHANGES = 200;

const DrawingPath = z.string().min(1).max(4096);
const ElementId = z.string().min(1).max(200);
const Coordinate = z.number().min(-1_000_000).max(1_000_000);
const Size = z.number().min(0).max(1_000_000);
const Point = z.tuple([Coordinate, Coordinate]);
const ElementFields = {
  x: Coordinate,
  y: Coordinate,
  width: Size,
  height: Size,
  text: z.string().min(1).max(20_000),
  strokeColor: z.string().min(1).max(64),
  backgroundColor: z.string().min(1).max(64),
  points: z.array(Point).min(2).max(2_000),
  link: z.string().max(4096).nullable(),
  groupIds: z.array(ElementId).max(32),
  frameId: ElementId.nullable(),
};
const Optional = z.object(ElementFields).partial().shape;

export const DrawingElementInput = z
  .object({
    ...Optional,
    id: ElementId.optional(),
    type: z.enum(DRAWING_ELEMENT_TYPES),
    x: Coordinate,
    y: Coordinate,
    containerId: ElementId.optional(),
    start: ElementId.optional(),
    end: ElementId.optional(),
  })
  .strict();
export type DrawingElementInput = z.output<typeof DrawingElementInput>;

const ExpectedVersion = { id: ElementId, expectedVersion: z.number().int().nonnegative() };
export const DrawingElementChange = z.object({ ...Optional, ...ExpectedVersion }).strict();
export type DrawingElementChange = z.output<typeof DrawingElementChange>;

export const DrawingEdit = z
  .object({
    add: z.array(DrawingElementInput).max(MAX_DRAWING_CHANGES).optional(),
    update: z.array(DrawingElementChange).max(MAX_DRAWING_CHANGES).optional(),
    delete: z.array(z.object(ExpectedVersion).strict()).max(MAX_DRAWING_CHANGES).optional(),
  })
  .strict();
export type DrawingEdit = z.output<typeof DrawingEdit>;

const RequestId = z
  .string()
  .regex(/^[\x20-\x7e]{1,64}$/u)
  .optional();
export const DrawingEditInput = DrawingEdit.extend({ path: DrawingPath, requestId: RequestId });
export const DrawingCreateInput = z
  .object({
    path: DrawingPath,
    elements: z.array(DrawingElementInput).max(MAX_DRAWING_CHANGES).optional(),
    requestId: RequestId,
  })
  .strict();

export const DrawingWriteResult = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      path: z.string().min(1),
      elements: z.array(z.object({ id: z.string(), version: z.number() }).strict()),
      warning: z.string().min(1).optional(),
    })
    .strict(),
  z.object({ ok: z.literal(false), reason: z.string().min(1) }).strict(),
]);

export const DrawingReadInput = z
  .object({ path: DrawingPath, points: z.boolean().optional() })
  .strict();
const Binding = z.object({ elementId: z.string() }).nullable().optional();
const Reference = z.string().nullable().optional();
export const DrawingElementSummary = z
  .object({
    id: z.string(),
    type: z.string(),
    version: z.number(),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    angle: z.number().optional(),
    text: z.string().optional(),
    strokeColor: z.string().optional(),
    backgroundColor: z.string().optional(),
    link: Reference,
    groupIds: z.array(z.string()).optional(),
    frameId: Reference,
    containerId: Reference,
    startBinding: Binding,
    endBinding: Binding,
    boundElements: z.array(z.object({ id: z.string(), type: z.string() })).optional(),
    points: z.array(z.array(z.number())).optional(),
    pointCount: z.number().optional(),
  })
  .strict();
export type DrawingElementSummary = z.output<typeof DrawingElementSummary>;
export const DrawingReadResult = z
  .object({
    path: z.string(),
    live: z.boolean(),
    elements: z.array(DrawingElementSummary),
    appState: z.record(z.string(), z.unknown()),
  })
  .strict();
export type DrawingReadResult = z.output<typeof DrawingReadResult>;
