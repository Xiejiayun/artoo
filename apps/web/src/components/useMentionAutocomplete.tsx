import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { Member } from "@artoo/domain";

/** Suggestions reuse the authorized member list; typed text alone never adds a recipient. */
export function useMentionAutocomplete({ value, people, enabled, textarea, onPick }: {
  value: string; people: Member[]; enabled: boolean; textarea: RefObject<HTMLTextAreaElement | null>;
  onPick: (body: string, personId: string) => void;
}) {
  const [cursor, setCursor] = useState<number | null>(null);
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<Error | null>(null);
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const completed = useRef<{ value: string; caret: number } | null>(null);
  const match = cursor === null ? null : /(?:^|[\s([{])@([\p{L}\p{N}\p{M}_-]*)$/u.exec(value.slice(0, cursor));
  const query = match?.[1];
  const start = query === undefined || cursor === null ? -1 : cursor - query.length - 1;
  const candidates = enabled && query !== undefined ? people.filter(person => person.display_name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, 8) : [];
  const active = Math.min(index, candidates.length - 1);
  const visible = candidates.length > 0;
  useEffect(() => {
    if (!enabled || !value) { setCursor(null); setError(null); }
  }, [enabled, value]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [active, query, visible]);
  const syncCursor = (element: HTMLTextAreaElement): void => {
    if (completed.current?.value === element.value && completed.current.caret === element.selectionStart && element.selectionStart === element.selectionEnd) { setCursor(null); return; }
    completed.current = null;
    setCursor(element.selectionStart === element.selectionEnd ? element.selectionStart : null);
    setIndex(0); setError(null);
  };
  const hide = (): void => setCursor(null);
  const choose = (person: Member): void => {
    if (start < 0 || cursor === null) return;
    // Replace the whole trigger token when the caret is in its middle, preserving following text.
    let end = cursor;
    while (end < value.length && /[\p{L}\p{N}\p{M}_-]/u.test(value[end]!)) end++;
    const suffix = value.slice(end), label = `@${person.display_name}`;
    const hasSpace = /^\s/u.test(suffix);
    const insertion = label + (!suffix || /^[\p{L}\p{N}@]/u.test(suffix) ? " " : "");
    const body = value.slice(0, start) + insertion + suffix;
    if (body.length > 20000) { setError(new Error("This mention would exceed the message length limit.")); hide(); return; }
    onPick(body, person.id); hide(); setError(null);
    const caret = start + insertion.length + (hasSpace ? 1 : 0);
    completed.current = { value: body, caret };
    requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(caret, caret); });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!visible) return false;
    if (event.key === "Escape") { event.preventDefault(); hide(); return true; }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault(); setIndex((active + (event.key === "ArrowDown" ? 1 : -1) + candidates.length) % candidates.length); return true;
    }
    if (event.key === "Enter" && !event.repeat && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault(); choose(candidates[active]!); return true;
    }
    return false;
  };
  return { syncCursor, hide, onKeyDown, error, open: visible,
    inputProps: { "aria-autocomplete": enabled ? "list" as const : undefined, "aria-haspopup": enabled ? "listbox" as const : undefined,
      "aria-controls": visible ? id : undefined, "aria-activedescendant": visible ? `${id}-${active}` : undefined },
    popup: visible ? <div ref={list} id={id} role="listbox" aria-label="People to mention" className="conversation-mention-suggestions">
      {candidates.map((person, position) => <button key={person.id} id={`${id}-${position}`} type="button" role="option" tabIndex={-1} aria-selected={position === active}
        onPointerDown={event => event.preventDefault()} onClick={() => choose(person)}>
        <span>@{person.display_name}</span>{people.some(other => other.id !== person.id && other.display_name === person.display_name) && <small>{person.id}</small>}
      </button>)}
    </div> : null,
  };
}
