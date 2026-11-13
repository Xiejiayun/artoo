import { useInfiniteQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { usePollMs } from "../app/RealtimeContext.js";
import { Button, Input, Modal } from "../ui/index.js";
import { ActionError } from "./ActionError.js";
import "./message-search.css";

export function MessageSearch({
  roomId,
  threadRootId,
  onClose,
}: {
  roomId: string;
  threadRootId?: string;
  onClose: () => void;
}): React.ReactNode {
  const api = useApi();
  const [draft, setDraft] = useState("");
  const [term, setTerm] = useState("");
  const composing = useRef(false);
  const results = useInfiniteQuery({
    queryKey: queryKeys.messageSearch(roomId, term, threadRootId),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const page = await api.listMessages(roomId, {
        q: term,
        limit: 50,
        ...(threadRootId ? { thread_root_id: threadRootId } : {}),
        ...(pageParam ? { before: pageParam } : {}),
      });
      if (page.has_more && (!page.next_before || page.next_before === pageParam || !page.messages.length))
        throw new Error("Search pagination did not advance. Refresh the search.");
      return page;
    },
    enabled: !!term,
    getNextPageParam: (page) => (page.has_more ? (page.next_before ?? undefined) : undefined),
    gcTime: 0,
    refetchInterval: usePollMs(15000),
  });
  const ids = new Set<string>();
  const messages = (results.data?.pages ?? [])
    .flatMap((page) => [...page.messages].reverse())
    .map((message) => api.messageForDisplay(message))
    .filter((message) => {
      if (message.payload.moderation === "removed" || ids.has(message.id)) return false;
      ids.add(message.id);
      return true;
    });
  return (
    <Modal open title={threadRootId ? "Search replies" : "Search messages"} onClose={onClose}>
      <div className="message-search u-stack">
        <form
          className="u-stack-sm"
          onSubmit={(event) => {
            event.preventDefault();
            if (!draft.trim() || composing.current) return;
            if (term === draft.trim()) void results.refetch();
            else setTerm(draft.trim());
          }}
        >
          <Input
            label="Search message text"
            value={draft}
            maxLength={200}
            onChange={(event) => setDraft(event.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (composing.current || event.nativeEvent.isComposing)) event.preventDefault();
            }}
          />
          <p className="t-subtle">
            {threadRootId ? "Search replies in this thread." : "Search all message history and replies in this room."}{" "}
            Matches literal text, ignoring case. Newest matches appear first.
          </p>
          <Button type="submit" disabled={!draft.trim()}>
            Search
          </Button>
        </form>
        <ActionError error={results.error} />
        {results.isError && <Button onClick={() => void results.refetch()}>Retry search</Button>}
        {term && results.isFetching && <p role="status">Searching messages…</p>}
        {term && !results.isFetching && !results.isError && !messages.length && (
          <p role="status">No matching messages.</p>
        )}
        <ol aria-label="Search results" className="message-search__results">
          {messages.map((message) => {
            const params = new URLSearchParams({
              room: roomId,
              thread: message.thread_root_id ?? message.id,
              message: message.id,
            });
            return (
              <li key={message.id}>
                <p>
                  {message.body.slice(0, 800)}
                  {message.body.length > 800 ? "…" : ""}
                </p>
                <time dateTime={message.created_at}>{new Date(message.created_at).toLocaleString()}</time>
                <Link to={`/channels?${params}`} onClick={onClose}>
                  Open {message.thread_root_id ? "reply" : "message"}
                </Link>
              </li>
            );
          })}
        </ol>
        {results.hasNextPage && (
          <Button onClick={() => void results.fetchNextPage()} disabled={results.isFetching}>
            Load older matches
          </Button>
        )}
      </div>
    </Modal>
  );
}
