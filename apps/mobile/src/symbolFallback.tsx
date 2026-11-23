import type { SymbolViewProps } from "expo-symbols";
import {
  BellOff,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleEllipsis,
  CircleHelp,
  Hammer,
  House,
  type LucideIcon,
  Search,
  UserPlus,
} from "lucide-react-native";

// SF Symbols draw only on iOS. Elsewhere a SymbolView shows its fallback: the lucide icon for the same symbol.
const LUCIDE: Record<string, LucideIcon> = {
  "bell.slash": BellOff,
  checkmark: Check,
  "checkmark.circle": CircleCheck,
  "chevron.down": ChevronDown,
  "chevron.right": ChevronRight,
  "ellipsis.circle": CircleEllipsis,
  hammer: Hammer,
  house: House,
  magnifyingglass: Search,
  "person.crop.circle.badge.plus": UserPlus,
  "questionmark.circle": CircleHelp,
};

export function symbolFallback(name: SymbolViewProps["name"], size: number, color: string) {
  const Icon = typeof name === "string" ? LUCIDE[name] : undefined;
  return Icon ? <Icon size={size} color={color} strokeWidth={2} /> : null;
}
