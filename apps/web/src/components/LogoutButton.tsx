import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";

/**
 * Sign-out control (#34). Renders only when a session is cached — i.e. auth is
 * enabled and the user is signed in. It reads the session cache without its own
 * fetch (`enabled: false`); AuthGate owns the session probe. On logout it clears
 * cached data and re-probes the session, so AuthGate falls back to the login page.
 */
export function LogoutButton(): React.ReactNode {
  const api = useApi();
  const queryClient = useQueryClient();
  const session = useQuery({
    queryKey: queryKeys.session,
    queryFn: () => api.getSession(),
    enabled: false,
  });

  const logout = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: async () => {
      queryClient.clear();
      await queryClient.invalidateQueries({ queryKey: queryKeys.session });
    },
  });

  if (session.data === undefined) {
    return null;
  }

  return (
    <button
      type="button"
      className="logout"
      disabled={logout.isPending}
      onClick={() => logout.mutate()}
    >
      Sign out
    </button>
  );
}
