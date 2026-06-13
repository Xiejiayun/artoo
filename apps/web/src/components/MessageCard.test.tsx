// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { fakeApi, messageFixture, renderWithProviders } from "../test/utils.js";
import { MessageCard } from "./MessageCard.js";

const client = fakeApi({});

describe("MessageCard", () => {
  it("renders plain text", () => {
    renderWithProviders(
      <MessageCard message={messageFixture({ id: "m1", kind: "text", body: "hello world" })} />,
      { client },
    );
    expect(screen.getByText("hello world")).toBeInTheDocument();
  });

  it("renders an approval request defensively from an opaque payload", () => {
    renderWithProviders(
      <MessageCard
        message={messageFixture({ id: "m2", kind: "approval_request", payload: { action: "git.push" } })}
      />,
      { client },
    );
    expect(screen.getByText(/Approval requested: git\.push/)).toBeInTheDocument();
  });

  it("degrades an unknown kind to a system-notice card", () => {
    renderWithProviders(
      <MessageCard message={messageFixture({ id: "m3", kind: "future_kind", body: "later" })} />,
      { client },
    );
    expect(screen.getByLabelText("system_notice message")).toHaveAttribute(
      "data-kind",
      "system_notice",
    );
  });

  it("does not crash on a malformed artifact payload (non-string uri)", () => {
    renderWithProviders(
      <MessageCard
        message={messageFixture({ id: "m4", kind: "artifact", payload: { uri: 123 }, body: "fallback" })}
      />,
      { client },
    );
    expect(screen.getByText(/Artifact: fallback/)).toBeInTheDocument();
  });
});
