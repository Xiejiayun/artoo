/**
 * Feedback components (#68): Skeleton, EmptyState, ErrorState, OfflineBanner,
 * Toast (+ minimal provider/hook), Tooltip, Modal. Implements gate §8 (feedback
 * components) and §9 (loading/empty/error/offline/toast/tooltip states) on the
 * #65 tokens. Library primitives — surfaces (#69+) consume them.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Icon, X, CircleAlert, Inbox, WifiOff, CircleCheck, TriangleAlert } from "./Icon.js";
import type { LucideIcon } from "lucide-react";
import type { Tone } from "./Badge.js";
import "./feedback.css";

/* ----------------------------------------------------------------- Skeleton */
export function Skeleton({ width, height = 16, radius, className }: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  className?: string;
}): React.ReactNode {
  return (
    <span
      className={["ui-skeleton", className ?? ""].filter(Boolean).join(" ")}
      style={{ width, height, borderRadius: radius ?? "var(--radius-sm)" }}
      aria-hidden="true"
    />
  );
}

/** Multi-line text skeleton; last line is shorter. */
export function SkeletonText({ lines = 3 }: { lines?: number }): React.ReactNode {
  return (
    <span className="ui-skeleton-text" aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} height={12} width={i === lines - 1 ? "60%" : "100%"} />
      ))}
    </span>
  );
}

/* --------------------------------------------------------------- EmptyState */
export function EmptyState({ icon = Inbox, title, description, action }: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}): React.ReactNode {
  return (
    <div className="ui-state" role="status">
      <Icon icon={icon} size={22} className="ui-state__icon" />
      <span className="ui-state__title">{title}</span>
      {description ? <span className="ui-state__desc">{description}</span> : null}
      {action ? <div className="ui-state__action">{action}</div> : null}
    </div>
  );
}

/* --------------------------------------------------------------- ErrorState */
export function ErrorState({ title = "Something went wrong", description, action }: {
  title?: string;
  description?: string;
  action?: ReactNode;
}): React.ReactNode {
  return (
    <div className="ui-state ui-state--error" role="alert">
      <Icon icon={CircleAlert} size={22} className="ui-state__icon" />
      <span className="ui-state__title">{title}</span>
      {description ? <span className="ui-state__desc">{description}</span> : null}
      {action ? <div className="ui-state__action">{action}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------ OfflineBanner */
/** Persistent, non-blocking offline/reconnecting banner with queued count
 *  (gate §9). */
export function OfflineBanner({ queuedCount = 0, reconnecting = false }: {
  queuedCount?: number;
  reconnecting?: boolean;
}): React.ReactNode {
  return (
    <div className="ui-offline-banner" role="status">
      <Icon icon={WifiOff} size={14} />
      <span>
        {reconnecting ? "Reconnecting…" : "Offline"}
        {queuedCount > 0 ? ` — ${queuedCount} change${queuedCount === 1 ? "" : "s"} queued` : ""}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------- Toast */
export interface ToastItem {
  id: string;
  tone?: Tone;
  message: ReactNode;
  /** Override auto-dismiss. By default non-danger toasts dismiss and danger persists. */
  durationMs?: number;
}

const TONE_ICON: Partial<Record<Tone, LucideIcon>> = {
  success: CircleCheck,
  danger: CircleAlert,
  warning: TriangleAlert,
  info: CircleAlert,
};

export function Toast({ tone = "neutral", message, onClose }: {
  tone?: Tone;
  message: ReactNode;
  onClose?: () => void;
}): React.ReactNode {
  const glyph = TONE_ICON[tone];
  return (
    <div className={`ui-toast ui-toast--${tone}`} role={tone === "danger" ? "alert" : "status"}>
      {glyph ? <Icon icon={glyph} size={16} /> : null}
      <span className="ui-toast__msg">{message}</span>
      {onClose ? (
        <button type="button" className="ui-toast__close" aria-label="Dismiss" onClick={onClose}>
          <Icon icon={X} size={14} />
        </button>
      ) : null}
    </div>
  );
}

interface ToastApi {
  push: (t: Omit<ToastItem, "id">) => void;
}
const ToastContext = createContext<ToastApi | null>(null);

/** Minimal toast host: provides `useToast().push(...)` and renders a viewport. */
export function ToastProvider({ children }: { children: ReactNode }): React.ReactNode {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const remove = useCallback((id: string) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback((t: Omit<ToastItem, "id">) => {
    seq.current += 1;
    const id = `t${seq.current}`;
    const durationMs = t.durationMs ?? (t.tone === "danger" ? undefined : 4000);
    setItems((xs) => [...xs, { ...t, durationMs, id }]);
  }, []);
  const api = useMemo(() => ({ push }), [push]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="ui-toast-viewport" aria-live="polite">
        {items.map((t) => (
          <ToastAutoDismiss key={t.id} item={t} onClose={() => remove(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastAutoDismiss({ item, onClose }: { item: ToastItem; onClose: () => void }): React.ReactNode {
  useEffect(() => {
    if (item.durationMs === undefined) {
      return;
    }
    const h = setTimeout(onClose, item.durationMs);
    return () => clearTimeout(h);
  }, [item, onClose]);
  return <Toast tone={item.tone} message={item.message} onClose={onClose} />;
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (ctx === null) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}

/* ------------------------------------------------------------------ Tooltip */
/** Supplementary label on hover/focus (gate §9: never for critical info). */
export function Tooltip({ label, children }: { label: string; children: ReactNode }): React.ReactNode {
  return (
    <span className="ui-tooltip" data-tip={label}>
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------- Modal */
export function Modal({ open, onClose, title, children, footer }: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}): React.ReactNode {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "Tab" && panelRef.current) {
        trapFocus(e, panelRef.current);
      }
    };
    document.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) {
    return null;
  }
  return (
    <div className="ui-modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="ui-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={title != null ? titleId : undefined}
        aria-label={title == null ? "Dialog" : undefined}
        tabIndex={-1}
        ref={panelRef}
      >
        <div className="ui-modal__header">
          {title != null ? <span className="ui-modal__title" id={titleId}>{title}</span> : <span className="ui-modal__title" />}
          <button type="button" className="ui-modal__close" aria-label="Close" onClick={onClose}>
            <Icon icon={X} size={16} />
          </button>
        </div>
        <div className="ui-modal__body">{children}</div>
        {footer != null ? <div className="ui-modal__footer">{footer}</div> : null}
      </div>
    </div>
  );
}

function trapFocus(e: KeyboardEvent, root: HTMLElement): void {
  const focusables = Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
  if (focusables.length === 0) {
    e.preventDefault();
    root.focus();
    return;
  }
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
