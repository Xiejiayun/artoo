import { useProject } from "../app/useProject.js";
import { Select } from "../ui/index.js";
import { useLocation, useNavigate } from "react-router-dom";

export function ProjectPicker(): React.ReactNode {
  const { bootstrap, project, setSelectedProjectId } = useProject();
  const location = useLocation(), navigate = useNavigate();
  if (!project) return null;
  return <Select aria-label="Project" className="project-picker" value={project.id} onChange={(event) => {
    setSelectedProjectId(event.target.value);
    if (location.pathname === "/channels") {
      const search = new URLSearchParams(location.search);
      for (const key of ["room", "thread", "message", "notification", "project"]) search.delete(key);
      navigate({ pathname: location.pathname, search: search.toString() });
    }
  }}>
    {bootstrap.data?.projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
  </Select>;
}
