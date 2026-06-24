// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ListTodo } from "./Icon.js";
import { Breadcrumbs, NavItem, Toolbar, ToolbarSpacer } from "./nav.js";

afterEach(() => cleanup());

describe("ui nav primitives (#66)", () => {
  it("NavItem renders label + icon and reflects active state", () => {
    render(
      <NavItem as="a" href="/board" icon={ListTodo} active>
        Board
      </NavItem>,
    );
    const link = screen.getByText("Board").closest("a")!;
    expect(link).toHaveClass("ui-nav-item", "is-active");
    expect(link).toHaveAttribute("data-active", "true");
    expect(link).toHaveAttribute("href", "/board");
    // icon rendered (decorative svg)
    expect(link.querySelector("svg")).not.toBeNull();
  });

  it("NavItem shows a count badge only when count > 0", () => {
    const { rerender } = render(<NavItem count={3}>Inbox</NavItem>);
    expect(screen.getByText("3")).toBeInTheDocument();
    rerender(<NavItem count={0}>Inbox</NavItem>);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("NavItem is polymorphic via `as` (renders a button)", () => {
    render(
      <NavItem as="button" type="button">
        Action
      </NavItem>,
    );
    expect(screen.getByRole("button", { name: "Action" })).toBeInTheDocument();
  });

  it("Toolbar is a role=toolbar container; spacer renders", () => {
    render(
      <Toolbar aria-label="Filters">
        <span>left</span>
        <ToolbarSpacer />
        <span>right</span>
      </Toolbar>,
    );
    expect(screen.getByRole("toolbar", { name: "Filters" })).toBeInTheDocument();
  });

  it("Breadcrumbs marks the last crumb as current page and links the rest", () => {
    render(
      <Breadcrumbs
        items={[
          { label: "Tasks", href: "/" },
          { label: "Task 42" },
        ]}
      />,
    );
    expect(screen.getByText("Tasks").closest("a")).toHaveAttribute("href", "/");
    expect(screen.getByText("Task 42")).toHaveAttribute("aria-current", "page");
  });
});
