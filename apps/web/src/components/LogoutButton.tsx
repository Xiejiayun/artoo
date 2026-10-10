import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApi, useCommands } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { clearRoomDrafts } from "../app/roomDrafts.js";
import { Button } from "../ui/index.js";
import { LogOut } from "../ui/Icon.js";
import { ActionError } from "./ActionError.js";

/**
 * Sign-out control (#34). Renders only when a session is cached — i.e. auth is
 * enabled and the user is signed in. It reads the session cache without its own
 * fetch (`enabled: false`); AuthGate owns the session probe. On logout it clears
 * cached data and re-probes the session, so AuthGate falls back to the login page.
 */
export function LogoutButton(): React.ReactNode {
  const api = useApi();
  const commands = useCommands();
  const queryClient = useQueryClient();
  const session = useQuery({
    queryKey: queryKeys.session,
    queryFn: () => api.getSession(),
    enabled: false,
  });

  const logout = useMutation({
    mutationFn: async () => {
      api.invalidateAIConsent();
      commands.cancelPending();
      clearRoomDrafts();
      if (window.artooDesktop?.logout) { await window.artooDesktop.logout(); window.location.reload(); }
      else await api.logout();
    },
    onSuccess: async () => {
      queryClient.clear();
      await queryClient.invalidateQueries({ queryKey: queryKeys.session });
    },
  });

  if (session.data === undefined) {
    return null;
  }

  return (
    <><ActionError error={logout.error} /><Button
      variant="ghost"
      size="sm"
      iconLeft={LogOut}
      className="logout"
      loading={logout.isPending}
      onClick={() => logout.mutate()}
    >
      Sign out
    </Button></>
  );
}
