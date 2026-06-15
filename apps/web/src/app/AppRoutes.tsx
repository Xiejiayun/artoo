import { Route, Routes } from "react-router-dom";

import { BoardView } from "../components/BoardView.js";
import { AgentsPage, ComputersPage, SkillsPage } from "../components/InventoryPages.js";
import { MemoryPage } from "../components/MemoryPage.js";
import { Nav } from "../components/Nav.js";
import { RunsAuditPage } from "../components/RunsAuditPage.js";
import { WorkspaceLayout } from "../components/WorkspaceLayout.js";

/**
 * Product nav + route surface (no router/providers — App supplies BrowserRouter;
 * tests supply MemoryRouter). Routes render only backed server/domain contracts;
 * no client-only read models are invented for unfinished product lanes.
 */
export function AppRoutes(): React.ReactNode {
  return (
    <div className="app-shell">
      <Nav />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<WorkspaceLayout />} />
          <Route path="/board" element={<BoardView />} />
          <Route path="/computers" element={<ComputersPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/memory" element={<MemoryPage />} />
          <Route path="/runs" element={<RunsAuditPage />} />
        </Routes>
      </main>
    </div>
  );
}
