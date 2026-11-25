export interface Selection {
  readonly selectedHex: string | null;
  readonly targetHex: string | null;
  readonly targetScope: string | null;
  readonly hoverHex: string | null;
  readonly cursorHex: string | null;
  readonly marchUnits: number;
  readonly reinforceUnits: number;
}

export type SelectionAction =
  | { readonly type: "select"; readonly hex: string; readonly units: number }
  | { readonly type: "target"; readonly hex: string; readonly movable: number; readonly scope: string }
  | { readonly type: "untarget" }
  | { readonly type: "deselect" }
  | { readonly type: "reset" }
  | { readonly type: "hover"; readonly hex: string | null }
  | { readonly type: "cursor"; readonly hex: string | null }
  | { readonly type: "focus"; readonly hex: string }
  | { readonly type: "marchUnits"; readonly units: number }
  | { readonly type: "reinforceUnits"; readonly units: number };

export const NO_SELECTION: Selection = {
  selectedHex: null,
  targetHex: null,
  targetScope: null,
  hoverHex: null,
  cursorHex: null,
  marchUnits: 1,
  reinforceUnits: 1,
};

export function selectionReducer(state: Selection, action: SelectionAction): Selection {
  switch (action.type) {
    case "select":
      return {
        ...state,
        selectedHex: action.hex,
        targetHex: null,
        targetScope: null,
        marchUnits: Math.max(1, action.units - 1),
        reinforceUnits: 1,
      };
    case "target":
      return { ...state, targetHex: action.hex, targetScope: action.scope, marchUnits: Math.max(1, action.movable) };
    case "untarget":
      return { ...state, targetHex: null, targetScope: null };
    case "deselect":
      return { ...state, selectedHex: null, targetHex: null, targetScope: null, hoverHex: null };
    case "reset":
      return NO_SELECTION;
    case "hover":
      return state.hoverHex === action.hex ? state : { ...state, hoverHex: action.hex };
    case "cursor":
      return { ...state, cursorHex: action.hex };
    case "focus":
      return { ...state, hoverHex: null, cursorHex: action.hex };
    case "marchUnits":
      return { ...state, marchUnits: action.units };
    case "reinforceUnits":
      return { ...state, reinforceUnits: action.units };
  }
}

export function lockedTarget(selection: Selection, scope: string | null, targets: ReadonlyMap<string, unknown>): string | null {
  const { targetHex, targetScope } = selection;
  return targetHex !== null && scope !== null && targetScope === scope && targets.has(targetHex) ? targetHex : null;
}
