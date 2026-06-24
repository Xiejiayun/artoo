// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Button, Input, SearchInput, Select, Textarea } from "./forms.js";

afterEach(() => cleanup());

describe("ui form controls (#67)", () => {
  it("Button applies variant/size classes and fires onClick", async () => {
    const onClick = vi.fn();
    render(
      <Button variant="primary" size="sm" onClick={onClick}>
        Save
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "Save" });
    expect(btn).toHaveClass("ui-btn", "ui-btn--primary", "ui-btn--sm");
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("Button loading is busy + disabled and does not fire onClick", async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Submit
      </Button>,
    );
    const btn = screen.getByRole("button");
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "true");
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("Input wires label, error state, and aria-invalid/describedby", () => {
    render(<Input label="Title" errorText="Required" defaultValue="" />);
    const input = screen.getByLabelText("Title");
    expect(input).toHaveAttribute("aria-invalid", "true");
    const err = screen.getByRole("alert");
    expect(err).toHaveTextContent("Required");
    expect(input).toHaveAttribute("aria-describedby", err.id);
  });

  it("Select renders options and is labelled", () => {
    render(
      <Select label="Priority" defaultValue="p2">
        <option value="p1">P1</option>
        <option value="p2">P2</option>
      </Select>,
    );
    expect(screen.getByLabelText("Priority")).toHaveValue("p2");
  });

  it("Textarea wires label/helper text and default row sizing", () => {
    render(<Textarea label="Notes" helperText="Markdown supported" defaultValue="Initial notes" />);
    const textarea = screen.getByLabelText("Notes");
    const helper = screen.getByText("Markdown supported");
    expect(textarea).toHaveValue("Initial notes");
    expect(textarea).toHaveAttribute("rows", "3");
    expect(textarea).toHaveAttribute("aria-describedby", helper.id);
  });

  it("SearchInput shows a clear button only with a value and calls onClear", async () => {
    const onClear = vi.fn();
    const { rerender } = render(<SearchInput value="" onClear={onClear} onChange={() => {}} />);
    expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
    rerender(<SearchInput value="task" onClear={onClear} onChange={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("SearchInput clears from Escape without swallowing caller key handling", async () => {
    const onClear = vi.fn();
    const onKeyDown = vi.fn();
    render(<SearchInput value="task" onClear={onClear} onKeyDown={onKeyDown} onChange={() => {}} />);
    await userEvent.click(screen.getByRole("searchbox"));
    await userEvent.keyboard("{Escape}");
    expect(onClear).toHaveBeenCalledOnce();
    expect(onKeyDown).toHaveBeenCalledOnce();
  });
});
