import { createFileRoute } from "@tanstack/react-router";

import { AutomationsPage } from "../components/automations/AutomationsPage";

export const Route = createFileRoute("/automations")({
  component: AutomationsPage,
});
