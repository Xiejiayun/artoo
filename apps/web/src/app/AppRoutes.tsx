import { Route, Routes } from "react-router-dom";

import { BoardView } from "../components/BoardView.js";
import { Nav } from "../components/Nav.js";
import { PlaceholderPage } from "../components/PlaceholderPage.js";
import { WorkspaceLayout } from "../components/WorkspaceLayout.js";

/**
 * Product nav + route surface (no router/providers — App supplies BrowserRouter;
 * tests supply MemoryRouter). Only Workspace + Board are backed by v0.1 APIs; the
 * rest are explicit placeholders pending #11–#15 contracts.
 */
export function AppRoutes(): React.ReactNode {
  return (
    <div className="app-shell">
      <Nav />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<WorkspaceLayout />} />
          <Route path="/board" element={<BoardView />} />
          <Route
            path="/computers"
            element={<PlaceholderPage title="Computers" waitingFor="#15 scheduler/runtime" />}
          />
          <Route
            path="/agents"
            element={<PlaceholderPage title="Agents" waitingFor="#15 scheduler/runtime" />}
          />
          <Route
            path="/skills"
            element={<PlaceholderPage title="Skills" waitingFor="#13 skill registry" />}
          />
          <Route
            path="/memory"
            element={<PlaceholderPage title="Memory" waitingFor="#14 memory service" />}
          />
          <Route
            path="/runs"
            element={<PlaceholderPage title="Runs & Audit" waitingFor="#17 observability" />}
          />
        </Routes>
      </main>
    </div>
  );
}
