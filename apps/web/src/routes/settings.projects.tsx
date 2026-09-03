import { createFileRoute } from "@tanstack/react-router";

import { ProjectsSettingsPanel } from "../components/settings/ProjectSettingsPanel";

export const Route = createFileRoute("/settings/projects")({
  component: ProjectsSettingsPanel,
});
