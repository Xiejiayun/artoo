// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { bootstrapFixture, fakeApi, memoryFixture, renderWithProviders } from "../test/utils.js";
import { MemoryPage } from "./MemoryPage.js";

function bootstrap() {
  return bootstrapFixture();
}

const proposed = memoryFixture({ id: "mem_p", status: "proposed", scope: "project", text: "proposed idea" });
const accepted = memoryFixture({ id: "mem_a", status: "accepted", scope: "project", text: "accepted rule" });

describe("MemoryPage", () => {
  it("announces loading while the memory bootstrap is pending", () => {
    const client = fakeApi({
      bootstrap: () => new Promise(() => undefined),
    });

    renderWithProviders(<MemoryPage />, { client, route: "/memory" });

    expect(screen.getByRole("status", { name: "Loading memory" })).toBeInTheDocument();
  });

  it("announces loading while the memory list is pending", async () => {
    const client = fakeApi({
      bootstrap: async () => bootstrap(),
      listMemories: () => new Promise(() => undefined),
      getMemoryContext: async () => ({ memories: [], source_memory_ids: [] }),
    });

    renderWithProviders(<MemoryPage />, { client, route: "/memory" });

    expect(await screen.findByRole("status", { name: "Loading memories" })).toBeInTheDocument();
  });

  it("lists memories and sources the injectable panel only from /memories/context", async () => {
    const client = fakeApi({
      bootstrap: async () => bootstrap(),
      listMemories: async () => ({ memories: [proposed, accepted] }),
      getMemoryContext: async () => ({ memories: [accepted], source_memory_ids: ["mem_a"] }),
    });
    renderWithProviders(<MemoryPage />, { client, route: "/memory" });

    const list = await screen.findByRole("region", { name: "Memories" });
    expect(await within(list).findByText("proposed idea")).toBeInTheDocument();
    expect(within(list).getByText("accepted rule")).toBeInTheDocument();

    // The injectable panel comes from /memories/context (accepted-only) — the
    // proposed memory must NOT appear there.
    const injectable = screen.getByRole("region", { name: "Injectable into ContextPack" });
    expect(await within(injectable).findByText("accepted rule")).toBeInTheDocument();
    expect(within(injectable).queryByText("proposed idea")).toBeNull();
    expect(within(injectable).getByText(/mem_a/)).toBeInTheDocument();
  });

  it("accepts a proposed memory and refreshes", async () => {
    const acceptMemory = vi.fn(async () => ({ memory: { ...proposed, status: "accepted" as const } }));
    const client = fakeApi({
      bootstrap: async () => bootstrap(),
      listMemories: async () => ({ memories: [proposed] }),
      getMemoryContext: async () => ({ memories: [], source_memory_ids: [] }),
      acceptMemory,
    });
    renderWithProviders(<MemoryPage />, { client, route: "/memory" });

    await userEvent.click(await screen.findByText("proposed idea"));
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(acceptMemory).toHaveBeenCalledWith("mem_p", expect.any(String));
  });

  it("filters the list by status", async () => {
    const listMemories = vi.fn(async (filters?: { status?: string }) =>
      filters?.status === "accepted" ? { memories: [accepted] } : { memories: [proposed, accepted] },
    );
    const client = fakeApi({
      bootstrap: async () => bootstrap(),
      listMemories,
      getMemoryContext: async () => ({ memories: [], source_memory_ids: [] }),
    });
    renderWithProviders(<MemoryPage />, { client, route: "/memory" });

    await screen.findByText("proposed idea");
    await userEvent.selectOptions(screen.getByLabelText("Status"), "accepted");

    expect(await screen.findByText("accepted rule")).toBeInTheDocument();
    expect(screen.queryByText("proposed idea")).toBeNull();
    expect(listMemories).toHaveBeenCalledWith(expect.objectContaining({ status: "accepted" }));
  });

  it("does not project-filter the curation list, so organization memories remain reviewable", async () => {
    const orgMemory = memoryFixture({
      id: "mem_org",
      status: "proposed",
      scope: "organization",
      project_id: null,
      text: "org-wide rule",
    });
    const listMemories = vi.fn(async () => ({ memories: [orgMemory] }));
    const client = fakeApi({
      bootstrap: async () => bootstrap(),
      listMemories,
      getMemoryContext: async () => ({ memories: [], source_memory_ids: [] }),
    });
    renderWithProviders(<MemoryPage />, { client, route: "/memory" });

    expect(await screen.findByText("org-wide rule")).toBeInTheDocument();
    expect(listMemories).toHaveBeenCalledWith(expect.not.objectContaining({ projectId: "proj_artoo" }));
  });

  it("shows provenance and supersession in the detail", async () => {
    const traced = memoryFixture({
      id: "mem_t",
      status: "superseded",
      scope: "project",
      text: "old rule",
      source_task_id: "task_99",
      superseded_by_id: "mem_new",
    });
    const client = fakeApi({
      bootstrap: async () => bootstrap(),
      listMemories: async () => ({ memories: [traced] }),
      getMemoryContext: async () => ({ memories: [], source_memory_ids: [] }),
    });
    renderWithProviders(<MemoryPage />, { client, route: "/memory" });

    await userEvent.click(await screen.findByText("old rule"));
    await userEvent.click(screen.getByText("Provenance and record details"));
    const detail = screen.getByRole("region", { name: "Provenance" });
    expect(within(detail).getByText("task_99")).toBeInTheDocument();
    expect(screen.getByText(/Superseded by mem_new/)).toBeInTheDocument();
  });

  it("supersedes an accepted memory with inherited scope refs", async () => {
    const supersedeMemory = vi.fn(async () => ({
      memory: { ...accepted, id: "mem_new" },
      superseded: { ...accepted, status: "superseded" as const },
    }));
    const client = fakeApi({
      bootstrap: async () => bootstrap(),
      listMemories: async () => ({ memories: [accepted] }),
      getMemoryContext: async () => ({ memories: [accepted], source_memory_ids: ["mem_a"] }),
      supersedeMemory,
    });
    renderWithProviders(<MemoryPage />, { client, route: "/memory" });

    // "accepted rule" appears in both the list and the injectable panel; scope to the list.
    const list = await screen.findByRole("region", { name: "Memories" });
    await userEvent.click(await within(list).findByText("accepted rule"));
    await userEvent.click(screen.getByRole("button", { name: "Supersede" }));
    await userEvent.type(screen.getByLabelText("Replacement text"), "newer rule");
    await userEvent.click(screen.getByRole("button", { name: "Save replacement" }));

    expect(supersedeMemory).toHaveBeenCalledWith(
      "mem_a",
      expect.objectContaining({ scope: "project", project_id: "proj_artoo", text: "newer rule" }),
      expect.any(String),
    );
  });

  it("keeps a replacement draft after a failed save and sends it when retried", async () => {
    const supersedeMemory = vi.fn().mockRejectedValueOnce(new Error("Connection interrupted")).mockResolvedValue({ memory: accepted, superseded: accepted });
    renderWithProviders(<MemoryPage />, { client: fakeApi({ bootstrap: async () => bootstrap(), listMemories: async () => ({ memories: [accepted] }), getMemoryContext: async () => ({ memories: [], source_memory_ids: [] }), supersedeMemory }), route: "/memory" });
    await userEvent.click(await screen.findByText("accepted rule"));
    await userEvent.click(screen.getByRole("button", { name: "Supersede" }));
    await userEvent.type(screen.getByLabelText("Replacement text"), "Preserve this carefully written replacement");
    await userEvent.click(screen.getByRole("button", { name: "Save replacement" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection interrupted");
    expect(screen.getByLabelText("Replacement text")).toHaveValue("Preserve this carefully written replacement");
    await userEvent.click(screen.getByRole("button", { name: "Save replacement" }));
    await waitFor(() => expect(supersedeMemory).toHaveBeenCalledTimes(2));
    expect(supersedeMemory.mock.calls[1]?.[1]).toMatchObject({ text: "Preserve this carefully written replacement" });
    await waitFor(() => expect(screen.queryByLabelText("Replacement text")).not.toBeInTheDocument());
  });

  it("keeps replacement drafts scoped to their selected memory", async () => {
    const another = memoryFixture({ ...accepted, id: "other_memory", text: "Another rule" });
    renderWithProviders(<MemoryPage />, { client: fakeApi({ bootstrap: async () => bootstrap(), listMemories: async () => ({ memories: [accepted, another] }), getMemoryContext: async () => ({ memories: [], source_memory_ids: [] }) }), route: "/memory" });
    await userEvent.click(await screen.findByText("accepted rule"));
    await userEvent.click(screen.getByRole("button", { name: "Supersede" }));
    await userEvent.type(screen.getByLabelText("Replacement text"), "Only belongs to the first memory");
    await userEvent.click(screen.getByText("Another rule"));
    expect(screen.queryByLabelText("Replacement text")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Supersede" }));
    expect(screen.getByLabelText("Replacement text")).toHaveValue("");
  });

  it("searches content and tags without changing context eligibility", async () => {
    renderWithProviders(<MemoryPage />, { client: fakeApi({ bootstrap: async () => bootstrap(), listMemories: async () => ({ memories: [proposed, { ...accepted, tags: ["release"] }] }), getMemoryContext: async () => ({ memories: [accepted], source_memory_ids: [accepted.id] }) }), route: "/memory" });
    const list = await screen.findByRole("region", { name: "Memories" });
    await within(list).findByText("proposed idea");
    await userEvent.type(screen.getByLabelText("Search memories"), "release");
    expect(within(list).queryByText("proposed idea")).not.toBeInTheDocument();
    expect(within(list).getByText("accepted rule")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Injectable into ContextPack" })).getByText("accepted rule")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(within(list).getByText("proposed idea")).toBeInTheDocument();
  });
});
