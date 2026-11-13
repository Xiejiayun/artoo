import { useEffect, useState } from "react";
import { Route, Routes } from "react-router-dom";

import { BoardView } from "../components/BoardView.js";
import { AgentsPage, ComputersPage, SkillsPage } from "../components/InventoryPages.js";
import { AgentHistoryPage } from "../components/AgentHistoryPage.js";
import { MemoryPage } from "../components/MemoryPage.js";
import { Nav } from "../components/Nav.js";
import { RunsAuditPage } from "../components/RunsAuditPage.js";
import { WorkspaceLayout } from "../components/WorkspaceLayout.js";
import { ConnectionStatus } from "../components/ConnectionStatus.js";
import { GoalsPage } from "../components/GoalsPage.js";
import { SettingsPage } from "../components/SettingsPage.js";
import { ChannelsPage } from "../components/ChannelsPage.js";
import { ProductHeader } from "../components/ProductHeader.js";
import { ReleasePage } from "../components/ReleasePage.js";

/**
 * Product nav + route surface (no router/providers — App supplies BrowserRouter;
 * tests supply MemoryRouter). Routes render only backed server/domain contracts;
 * no client-only read models are invented for unfinished product lanes.
 */
export function AppRoutes(): React.ReactNode {
  const [menuOpen, setMenuOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(true);
  useEffect(() => {
    if (!menuOpen) return;
    const previous = document.activeElement;
    const navigation = document.getElementById("primary-navigation");
    navigation?.querySelector<HTMLElement>("a, button")?.focus();
    const keyboard = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { event.preventDefault(); setMenuOpen(false); }
      if (event.key !== "Tab") return;
      const controls = Array.from(navigation?.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), summary") ?? []).filter((element) => element.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    const resize = (): void => { if (window.innerWidth > 760) setMenuOpen(false); };
    document.addEventListener("keydown", keyboard);
    window.addEventListener("resize", resize);
    return () => { document.removeEventListener("keydown", keyboard); window.removeEventListener("resize", resize); if (previous instanceof HTMLElement) previous.focus(); };
  }, [menuOpen]);
  return (
    <div className="app-shell" data-menu-open={menuOpen} data-details-open={detailsOpen}>
      <a className="os-skip-link" href="#main-content">Skip to content</a>
      <Nav onNavigate={() => setMenuOpen(false)} />
      {menuOpen && <button className="os-nav-backdrop" type="button" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
      <div className="app-content">
      <ProductHeader onToggleMenu={() => setMenuOpen(!menuOpen)} menuOpen={menuOpen} detailsOpen={detailsOpen} onToggleDetails={() => setDetailsOpen(!detailsOpen)} />
      <ConnectionStatus />
      <main className="app-main" id="main-content">
        <Routes>
          <Route path="/" element={<WorkspaceLayout />} />
          <Route path="/board" element={<BoardView />} />
          <Route path="/goals" element={<GoalsPage />} />
          <Route path="/channels" element={<ChannelsPage />} />
          <Route path="/release" element={<ReleasePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/computers" element={<ComputersPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/agents/:agentId/history" element={<AgentHistoryPage />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/memory" element={<MemoryPage />} />
          <Route path="/runs" element={<RunsAuditPage />} />
        </Routes>
      </main>
      </div>
    </div>
  );
}
