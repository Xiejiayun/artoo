// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ApiClientError } from "../api/client.js";
import { fakeApi, messageFixture, renderWithProviders } from "../test/utils.js";
import { ReportMessageModal } from "./ContentReporting.js";
import { ContentManagementSettings } from "./ContentManagement.js";

it("keeps a report reason after a network failure and sends only the selected message on explicit retry", async () => {
  const reportMessage = vi.fn().mockRejectedValueOnce(new ApiClientError("network_error", "Connection unavailable", 0))
    .mockResolvedValueOnce({ id: "report_1", message_id: "selected-message", reason: "Please review this", status: "open" });
  const close = vi.fn();
  renderWithProviders(<ReportMessageModal message={messageFixture({ id: "selected-message", kind: "text", body: "Selected fixture content" })} onClose={close} />, { client: fakeApi({ reportMessage }) });
  expect(reportMessage).not.toHaveBeenCalled();
  const reason = screen.getByLabelText("Report reason");
  await userEvent.type(reason, "Please review this");
  await userEvent.click(screen.getByRole("button", { name: "Send report" }));
  await screen.findByText("Connection unavailable");
  expect(reason).toHaveValue("Please review this"); expect(close).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Send report" }));
  await screen.findByText("Report received. Your team administrators can now review it.");
  expect(reportMessage).toHaveBeenCalledTimes(2);
  expect(reportMessage).toHaveBeenLastCalledWith("selected-message", "Please review this", expect.any(String));
});

it("requires explicit confirmation before disabling saved phrase filtering", async () => {
  const saveContentRules = vi.fn().mockResolvedValue({ blocked_phrases: [], version: "empty", updated_at: "2026-10-10" });
  renderWithProviders(<ContentManagementSettings />, { client: fakeApi({
    contentReports: async () => ({ reports: [], next_before: null }),
    contentRules: async () => ({ blocked_phrases: ["blocked fixture"], version: "existing", updated_at: "2026-10-10" }),
    saveContentRules,
  }) });
  await userEvent.click(screen.getByRole("button", { name: "Open content management" }));
  await userEvent.click(screen.getByRole("button", { name: "Posting rules" }));
  const editor = await screen.findByLabelText("Blocked phrases, one per line");
  await userEvent.clear(editor);
  await userEvent.click(screen.getByRole("button", { name: "Save posting rules" }));
  await screen.findByRole("dialog", { name: "Turn off phrase filtering?" });
  expect(saveContentRules).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Keep filtering" }));
  expect(saveContentRules).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Save posting rules" }));
  await userEvent.click(screen.getByRole("button", { name: "Turn off filtering" }));
  await waitFor(() => expect(saveContentRules).toHaveBeenCalledWith([], "existing", expect.any(String)));
});
