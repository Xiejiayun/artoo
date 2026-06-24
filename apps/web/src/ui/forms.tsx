/**
 * Form controls (#67): Button, Input, Textarea, Select, SearchInput. Implements
 * docs/production-ui-gate.md §8 (Button/Input/search-filter) and §9 (states:
 * hover/active/focus/disabled/error/loading) on the #65 tokens. Library
 * primitives — surfaces (#69+) consume them. Fixed dimensions so state changes
 * never resize layout (gate §8).
 */
import { forwardRef, useId, type ReactNode } from "react";

import { Icon, Loader, Search, X } from "./Icon.js";
import type { LucideIcon } from "lucide-react";
import "./forms.css";

/* ------------------------------------------------------------------ Button */
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  /** Shows a spinner and blocks interaction (also sets aria-busy/disabled). */
  loading?: boolean;
  iconLeft?: LucideIcon;
  iconRight?: LucideIcon;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading = false, iconLeft, iconRight, className, children, disabled, type, ...rest },
  ref,
) {
  const classes = ["ui-btn", `ui-btn--${variant}`, `ui-btn--${size}`, loading ? "is-loading" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Icon icon={Loader} size={size === "sm" ? 14 : 16} className="ui-btn__spinner" /> : iconLeft ? <Icon icon={iconLeft} size={size === "sm" ? 14 : 16} /> : null}
      {children != null ? <span className="ui-btn__label">{children}</span> : null}
      {!loading && iconRight ? <Icon icon={iconRight} size={size === "sm" ? 14 : 16} /> : null}
    </button>
  );
});

/* -------------------------------------------------------------- Field shell */
interface FieldProps {
  label?: ReactNode;
  helperText?: ReactNode;
  errorText?: ReactNode;
  id?: string;
  className?: string;
  children: (fieldId: string, invalid: boolean, describedBy?: string) => ReactNode;
}

function Field({ label, helperText, errorText, id, className, children }: FieldProps): React.ReactNode {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const invalid = errorText != null && errorText !== false;
  const msgId = invalid ? `${fieldId}-err` : helperText != null ? `${fieldId}-help` : undefined;
  return (
    <div className={["ui-field", invalid ? "is-invalid" : "", className ?? ""].filter(Boolean).join(" ")}>
      {label != null ? (
        <label className="ui-field__label" htmlFor={fieldId}>
          {label}
        </label>
      ) : null}
      {children(fieldId, invalid, msgId)}
      {invalid ? (
        <span className="ui-field__msg ui-field__msg--error" id={msgId} role="alert">
          {errorText}
        </span>
      ) : helperText != null ? (
        <span className="ui-field__msg" id={msgId}>
          {helperText}
        </span>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------- Input */
export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
  label?: ReactNode;
  helperText?: ReactNode;
  errorText?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, helperText, errorText, id, className, ...rest },
  ref,
) {
  return (
    <Field label={label} helperText={helperText} errorText={errorText} id={id} className={className}>
      {(fieldId, invalid, describedBy) => (
        <input
          ref={ref}
          id={fieldId}
          className="ui-input"
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          {...rest}
        />
      )}
    </Field>
  );
});

/* ---------------------------------------------------------------- Textarea */
export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode;
  helperText?: ReactNode;
  errorText?: ReactNode;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, helperText, errorText, id, className, rows = 3, ...rest },
  ref,
) {
  return (
    <Field label={label} helperText={helperText} errorText={errorText} id={id} className={className}>
      {(fieldId, invalid, describedBy) => (
        <textarea
          ref={ref}
          id={fieldId}
          className="ui-input ui-textarea"
          rows={rows}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          {...rest}
        />
      )}
    </Field>
  );
});

/* ------------------------------------------------------------------ Select */
export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: ReactNode;
  helperText?: ReactNode;
  errorText?: ReactNode;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, helperText, errorText, id, className, children, ...rest },
  ref,
) {
  return (
    <Field label={label} helperText={helperText} errorText={errorText} id={id} className={className}>
      {(fieldId, invalid, describedBy) => (
        <select
          ref={ref}
          id={fieldId}
          className="ui-input ui-select"
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          {...rest}
        >
          {children}
        </select>
      )}
    </Field>
  );
});

/* ------------------------------------------------------------- SearchInput */
export interface SearchInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  /** Called when the clear (x) button is pressed; also clears on Escape. */
  onClear?: () => void;
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { className, value, onClear, onKeyDown, "aria-label": ariaLabel, ...rest },
  ref,
) {
  const hasValue = value != null && value !== "";
  return (
    <div className={["ui-search", className ?? ""].filter(Boolean).join(" ")}>
      <Icon icon={Search} size={15} className="ui-search__icon" />
      <input
        ref={ref}
        type="search"
        className="ui-input ui-search__input"
        value={value}
        aria-label={ariaLabel ?? "Search"}
        onKeyDown={(e) => {
          if (e.key === "Escape" && onClear) {
            onClear();
          }
          onKeyDown?.(e);
        }}
        {...rest}
      />
      {hasValue && onClear ? (
        <button type="button" className="ui-search__clear" aria-label="Clear search" onClick={onClear}>
          <Icon icon={X} size={14} />
        </button>
      ) : null}
    </div>
  );
});
