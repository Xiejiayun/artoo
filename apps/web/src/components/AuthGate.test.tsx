// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApiClientError } from "../api/client.js";
import { queryKeys } from "../app/queryKeys.js";
import { createTestQueryClient, fakeApi, renderWithProviders } from "../test/utils.js";
import { AuthGate } from "./AuthGate.js";
import { LoginPage, sanitizeReturnTo } from "./LoginPage.js";
import { LogoutButton } from "./LogoutButton.js";

const authedClient = () =>
  fakeApi({ getSession: async () => ({ user: { id: "u1", email: "a@b.c", name: "A" } }) });

const unauthedClient = () =>
  fakeApi({
    getSession: async () => {
      throw new ApiClientError("unknown", "unauthorized", 401);
    },
  });

describe("AuthGate", () => {
  it("renders the app when the session is valid", async () => {
    renderWithProviders(
      <AuthGate enabled>
        <div>PROTECTED APP</div>
      </AuthGate>,
      { client: authedClient() },
    );
    expect(await screen.findByText("PROTECTED APP")).toBeInTheDocument();
  });

  it("shows the login page when unauthenticated (401)", async () => {
    renderWithProviders(
      <AuthGate enabled>
        <div>PROTECTED APP</div>
      </AuthGate>,
      { client: unauthedClient() },
    );
    expect(await screen.findByRole("button", { name: "Sign in with Google" })).toBeInTheDocument();
    expect(screen.queryByText("PROTECTED APP")).toBeNull();
  });

  it("renders children directly and skips the session probe when disabled", async () => {
    const getSession = vi.fn();
    renderWithProviders(
      <AuthGate enabled={false}>
        <div>PROTECTED APP</div>
      </AuthGate>,
      { client: fakeApi({ getSession }) },
    );
    expect(await screen.findByText("PROTECTED APP")).toBeInTheDocument();
    expect(getSession).not.toHaveBeenCalled();
  });
});

describe("LoginPage", () => {
  it("starts the OAuth flow with a sanitized same-origin return_to", async () => {
    const navigate = vi.fn();
    renderWithProviders(<LoginPage returnTo="/board?x=1" navigate={navigate} />, {
      client: fakeApi({}),
    });
    await userEvent.click(screen.getByRole("button", { name: "Sign in with Google" }));
    expect(navigate).toHaveBeenCalledWith(
      "/auth/google/start?return_to=%2Fboard%3Fx%3D1",
    );
  });

  it("falls back to root for unsafe return_to values", async () => {
    const navigate = vi.fn();
    renderWithProviders(<LoginPage returnTo="//evil.example" navigate={navigate} />, {
      client: fakeApi({}),
    });
    await userEvent.click(screen.getByRole("button", { name: "Sign in with Google" }));
    expect(navigate).toHaveBeenCalledWith("/auth/google/start?return_to=%2F");
  });
});

describe("sanitizeReturnTo", () => {
  it("keeps same-origin relative paths", () => {
    expect(sanitizeReturnTo("/board")).toBe("/board");
    expect(sanitizeReturnTo("/tasks/task_1?tab=runs")).toBe("/tasks/task_1?tab=runs");
  });

  it("rejects absolute, protocol-relative, and backslash variants", () => {
    expect(sanitizeReturnTo("https://evil.example")).toBe("/");
    expect(sanitizeReturnTo("//evil.example")).toBe("/");
    expect(sanitizeReturnTo("/\\evil.example")).toBe("/");
    expect(sanitizeReturnTo("\\/evil")).toBe("/");
    expect(sanitizeReturnTo("relative")).toBe("/");
  });
});

describe("LogoutButton", () => {
  it("shows Sign out when a session is cached and triggers logout", async () => {
    const logout = vi.fn(async () => {});
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(queryKeys.session, { user: { id: "u1", email: "a@b.c" } });
    renderWithProviders(<LogoutButton />, { client: fakeApi({ logout }), queryClient });

    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(logout).toHaveBeenCalled();
  });

  it("renders nothing when there is no cached session", () => {
    renderWithProviders(<LogoutButton />, { client: fakeApi({}) });
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });
});
