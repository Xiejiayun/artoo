import { useQuery } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";

import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { LoginPage } from "./LoginPage.js";

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
  const location = useLocation();
  const session = useQuery({
    queryKey: queryKeys.session,
    queryFn: () => api.getSession(),
    retry: false,
  });

  if (session.isLoading) {
    return <p role="status">Loading…</p>;
  }
  // 401 (or any auth probe failure) → show the login page. return_to is the
  // current same-origin path so the user lands back where they were.
  if (session.isError || session.data === undefined) {
    return <LoginPage returnTo={`${location.pathname}${location.search}`} />;
  }
  return <>{children}</>;
}
