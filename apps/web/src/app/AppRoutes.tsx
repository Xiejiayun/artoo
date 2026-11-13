import { lazy, Suspense, useEffect, useState } from "react";
import { Route, Routes, useLocation } from "react-router-dom";

import { RouteErrorBoundary } from "../components/RouteErrorBoundary.js";
import { BoardView } from "../components/BoardView.js";
import { Nav } from "../components/Nav.js";
import { WorkspaceLayout } from "../components/WorkspaceLayout.js";
import { ConnectionStatusBanner, ConnectionStatusIndicator, useConnectionStatus } from "../components/ConnectionStatus.js";
import { LoadingView } from "../components/LoadingView.js";
import { GoalsPage } from "../components/GoalsPage.js";
import { ChannelsPage } from "../components/ChannelsPage.js";
import { ProductHeader } from "../components/ProductHeader.js";

// Low-frequency pages are split out of the entry bundle.
const lazyPage = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) =>
  lazy(async () => ({ default: (await load())[name] }));
const AgentsPage = lazyPage(() => import("../components/InventoryPages.js"), "AgentsPage");
const ComputersPage = lazyPage(() => import("../components/InventoryPages.js"), "ComputersPage");
const SkillsPage = lazyPage(() => import("../components/InventoryPages.js"), "SkillsPage");
const AgentHistoryPage = lazyPage(() => import("../components/AgentHistoryPage.js"), "AgentHistoryPage");
const MemoryPage = lazyPage(() => import("../components/MemoryPage.js"), "MemoryPage");
const RunsAuditPage = lazyPage(() => import("../components/RunsAuditPage.js"), "RunsAuditPage");
const SettingsPage = lazyPage(() => import("../components/SettingsPage.js"), "SettingsPage");
const ReleasePage = lazyPage(() => import("../components/ReleasePage.js"), "ReleasePage");

/**
 * Product nav + route surface (no router/providers — App supplies BrowserRouter;
 * tests supply MemoryRouter). Routes render only backed server/domain contracts;
 * no client-only read models are invented for unfinished product lanes.
 */
export function AppRoutes(): React.ReactNode {
  const location = useLocation();
  const connection = useConnectionStatus();
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
      <ProductHeader onToggleMenu={() => setMenuOpen(!menuOpen)} menuOpen={menuOpen} detailsOpen={detailsOpen} onToggleDetails={() => setDetailsOpen(!detailsOpen)} connectionIndicator={<ConnectionStatusIndicator state={connection} />} />
      <ConnectionStatusBanner state={connection} />
      <main className="app-main" id="main-content">
        <RouteErrorBoundary resetKey={location.pathname}>
        <Suspense fallback={<LoadingView label="Loading…" shape="page" />}>
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
        </Suspense>
        </RouteErrorBoundary>
      </main>
      </div>
    </div>
  );
}
