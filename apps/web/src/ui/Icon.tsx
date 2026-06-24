/**
 * Icon — standardized lucide icon wrapper (#66). One place to fix size/stroke so
 * icons read consistently across the renderer (gate §8: "prefer lucide icons").
 * Decorative by default (aria-hidden); pass `label` for a meaningful standalone
 * icon (gate §8: icon-only controls require accessible labels).
 */
import type { LucideIcon } from "lucide-react";

export interface IconProps {
  icon: LucideIcon;
  /** Pixel size; defaults to 16 (inline with body text). */
  size?: number;
  className?: string;
  /** Accessible label for a standalone/meaningful icon. Omit for decorative. */
  label?: string;
}

export function Icon({ icon: Glyph, size = 16, className, label }: IconProps): React.ReactNode {
  return (
    <Glyph
      size={size}
      strokeWidth={1.75}
      className={className}
      aria-hidden={label === undefined ? true : undefined}
      aria-label={label}
      focusable={false}
    />
  );
}

// Curated icon set for the product surfaces — import from here so swaps are central.
export {
  LayoutGrid,
  ListTodo,
  Server,
  Bot,
  Puzzle,
  Brain,
  Activity,
  Plus,
  Search,
  X,
  Check,
  ChevronRight,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Clock,
  Loader,
  Inbox,
  LogOut,
  Wifi,
  WifiOff,
  TriangleAlert,
} from "lucide-react";
