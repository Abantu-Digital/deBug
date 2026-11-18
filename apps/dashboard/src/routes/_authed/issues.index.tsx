import { createFileRoute, redirect } from "@tanstack/react-router";
import { rangeSearch, type PageSearch } from "~/components/range-picker";

/**
 * There's no issue list: issues are reached by drilling down from Health (a box, then its
 * service or App code page, then the issue). Old links to /issues land on Health with the same
 * app and period.
 */
export const Route = createFileRoute("/_authed/issues/")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/", search: search as PageSearch });
  },
  validateSearch: (s: Record<string, unknown>): PageSearch => ({ app: typeof s.app === "string" ? s.app : undefined, ...rangeSearch(s) }),
});
