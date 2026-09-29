import { useProject } from "../app/useProject.js";
import { Select } from "../ui/index.js";

export function ProjectPicker(): React.ReactNode {
  const { bootstrap, project, setSelectedProjectId } = useProject();
  if (!project) return null;
  return <Select aria-label="Project" className="project-picker" value={project.id} onChange={(event) => setSelectedProjectId(event.target.value)}>
    {bootstrap.data?.projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
  </Select>;
}
