// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useEffect } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PriorityBadge, StatusBadge, toneFor } from "./Badge.js";
import { EmptyState, ErrorState, Modal, OfflineBanner, ToastProvider, useToast } from "./feedback.js";
import { Button } from "./forms.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ui feedback + badges (#68)", () => {
  it("toneFor maps the full domain vocabulary to semantic tones", () => {
    expect(toneFor.taskStatus("done")).toBe("success");
    expect(toneFor.taskStatus("blocked")).toBe("danger");
    expect(toneFor.taskStatus("review")).toBe("warning");
    expect(toneFor.taskStatus("cancelled")).toBe("danger");
    expect(toneFor.runStatus("awaiting_input")).toBe("warning");
    expect(toneFor.runStatus("cancelled")).toBe("danger");
    expect(toneFor.priority("p0")).toBe("danger");
    expect(toneFor.priority("p2")).toBe("accent");
    expect(toneFor.presence("online")).toBe("success");
    expect(toneFor.approval("needs_more_info")).toBe("warning");
    expect(toneFor.approval("expired")).toBe("neutral");
    // unknown -> neutral fallback (never crashes)
    expect(toneFor.taskStatus("brand_new_status")).toBe("neutral");
  });

  it("StatusBadge humanizes and tones the value; PriorityBadge upcases", () => {
    const { rerender } = render(<StatusBadge status="awaiting_approval" />);
    expect(screen.getByText("awaiting approval").closest(".ui-badge")).toHaveClass("ui-badge--warning");
    rerender(<PriorityBadge priority="p0" />);
    expect(screen.getByText("P0").closest(".ui-badge")).toHaveClass("ui-badge--danger");
  });

  it("EmptyState (status) and ErrorState (alert) render their content", () => {
    const { rerender } = render(<EmptyState title="No tasks yet" description="Create one" />);
    expect(screen.getByRole("status")).toHaveTextContent("No tasks yet");
    rerender(<ErrorState title="Failed to load" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Failed to load");
  });

  it("OfflineBanner shows queued command count", () => {
    render(<OfflineBanner queuedCount={2} />);
    expect(screen.getByRole("status")).toHaveTextContent("2 changes queued");
  });

  it("Modal renders when open, traps via dialog role, and closes on Escape + close button", async () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Modal open={false} onClose={onClose} title="Confirm">
        body
      </Modal>,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    rerender(
      <Modal open onClose={onClose} title="Confirm" footer={<Button>OK</Button>}>
        body
      </Modal>,
    );
    expect(screen.getByRole("dialog", { name: "Confirm" })).toHaveAttribute("aria-modal", "true");
    await userEvent.click(screen.getByRole("button", { name: "OK" }));
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("ToastProvider auto-dismisses non-danger toasts but keeps danger toasts sticky", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <ToastPusher tone="success" message="Saved" />
        <ToastPusher tone="danger" message="Failed" />
      </ToastProvider>,
    );
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Failed");
    act(() => vi.advanceTimersByTime(4000));
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Failed");
  });
});

function ToastPusher({ tone, message }: { tone: "success" | "danger"; message: string }): null {
  const toast = useToast();
  useEffect(() => {
    toast.push({ tone, message });
  }, [message, toast, tone]);
  return null;
}
