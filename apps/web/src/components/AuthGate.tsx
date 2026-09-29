import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";

import { ApiClientError } from "../api/client.js";
import { useApi, useCommands } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { clearRoomDrafts } from "../app/roomDrafts.js";
import { Button, ErrorState } from "../ui/index.js";
import { LoginPage } from "./LoginPage.js";
import { DesktopSetup } from "./DesktopSetup.js";

/**
 * Gates the app behind a Google session (#34). When `enabled` is false (the
 * default until the server `/auth/*` lands), it renders children directly so the
 * app and the Playwright E2E keep working during parallel server development.
 * The coordinated integration with the #34 server flips `enabled` on.
 */
export function AuthGate({
  enabled,
  children,
}: {
  enabled: boolean;
  children: React.ReactNode;
}): React.ReactNode {
  if (!enabled) {
    return <>{children}</>;
  }
  return <AuthGuard>{children}</AuthGuard>;
}

function AuthGuard({ children }: { children: React.ReactNode }): React.ReactNode {
  const api = useApi();
  const commands = useCommands();
  const queryClient = useQueryClient();
  const [accountId, setAccountId] = useState<string | null>(null);
  const location = useLocation();
  const [reconnect, setReconnect] = useState(false);
  const session = useQuery({
    queryKey: queryKeys.session,
    queryFn: () => api.getSession(),
    retry: false,
    enabled: !reconnect,
  });
  useEffect(() => {
    if (session.error instanceof ApiClientError && session.error.status === 401) {
      commands.cancelPending();
      clearRoomDrafts();
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "session" });
      setAccountId(null);
    }
  }, [commands, session.error, queryClient]);
  useEffect(() => {
    const nextAccount = session.data?.user?.id;
    if (!session.error && nextAccount && nextAccount !== accountId) {
      if (accountId !== null) {
        commands.cancelPending();
        clearRoomDrafts();
        queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "session" });
      }
      setAccountId(nextAccount);
    }
  }, [session.data?.user?.id, session.error, accountId, commands, queryClient]);
  if (reconnect) return <DesktopSetup />;

  if (session.isLoading) {
    return (
      <div className="auth-state">
        <p role="status" aria-label="Loading session">
          Loading session
        </p>
      </div>
    );
  }

  // Only a clean 401 means "not signed in" → start the login flow. Anything
  // else (500, network failure, malformed body) is a service error: show a
  // retryable state instead of bouncing the user into a Google login.
  if (session.isError) {
    if (session.error instanceof ApiClientError && session.error.status === 401) {
      if (window.artooDesktop?.pairDevice) return <DesktopSetup />;
      return <LoginPage returnTo={`${location.pathname}${location.search}`} />;
    }
    return <SessionError onRetry={() => void session.refetch()} onReconnect={window.artooDesktop?.pairDevice ? () => setReconnect(true) : undefined} />;
  }

  // Successful probe with no user is a malformed response, not an unauthenticated
  // user — treat it as a service error rather than a silent login bounce.
  if (!session.data?.user) {
    return <SessionError onRetry={() => void session.refetch()} />;
  }

  if (accountId !== session.data.user.id) return <div className="auth-state" role="status">Loading your account…</div>;
  return <>{children}</>;
}

/** Retryable error state for a failed/unusable `/auth/session` probe. */
function SessionError({ onRetry, onReconnect }: { onRetry: () => void; onReconnect?: () => void }): React.ReactNode {
  return (
    <div className="auth-state">
      <ErrorState
        title="Couldn’t verify your session"
        description="Please try again."
        action={
          <div className="action-row"><Button variant="primary" onClick={onRetry}>
            Retry
          </Button>{onReconnect && <Button onClick={onReconnect}>Change connection</Button>}</div>
        }
      />
    </div>
  );
}
