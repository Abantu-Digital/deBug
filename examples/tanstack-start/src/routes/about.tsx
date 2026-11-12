import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/about")({
  component: () => <p>About page. Navigating here left a breadcrumb.</p>,
});
