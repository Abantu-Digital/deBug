import { describe, expect, it } from "vitest";
import type { Category, Impact, Owner } from "@debugkit/schema";
import { filterIssues, issueFilterFromQuery, labelCounts, labelFilterOf, matchesStatus } from "./issue-filter";

const issue = (id: string, status: string, labels?: { category: Category; owner: Owner; impact: Impact }, flow?: string) => ({ id, status, flow, labels });

const issues = [
  issue("crash", "open", { category: "crash", owner: "app", impact: "blocked" }, "auth.login"),
  issue("server", "regressed", { category: "server", owner: "backend", impact: "blocked" }),
  issue("never-sent", "open", { category: "network.never_sent", owner: "app", impact: "degraded" }),
  issue("old", "resolved", { category: "server", owner: "backend", impact: "degraded" }),
  issue("unlabelled", "open"),
];
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("issue filters", () => {
  it("open means open or regressed, and is the default", () => {
    expect(ids(filterIssues(issues, {}))).toEqual(["crash", "server", "never-sent", "unlabelled"]);
    expect(matchesStatus({ status: "resolved" }, "all")).toBe(true);
    expect(ids(filterIssues(issues, { status: "resolved" }))).toEqual(["old"]);
  });

  it("answers what's blocking users right now, and whose it is", () => {
    const blocking = filterIssues(issues, { impact: "blocked" });
    expect(ids(blocking)).toEqual(["crash", "server"]);
    expect(ids(filterIssues(issues, { impact: "blocked", owner: "backend" }))).toEqual(["server"]);
    expect(ids(filterIssues(issues, { impact: "blocked", flow: "auth.login" }))).toEqual(["crash"]);
  });

  it("hides test errors unless asked, whatever the other filters (ABA-133)", () => {
    const withTest = [...issues, { ...issue("test-crash", "open", { category: "crash", owner: "app", impact: "blocked" }), test: true }];
    expect(ids(filterIssues(withTest, { impact: "blocked" }))).toEqual(["crash", "server"]);
    expect(ids(filterIssues(withTest, { impact: "blocked", tests: true }))).toEqual(["crash", "server", "test-crash"]);
    expect(issueFilterFromQuery(new URLSearchParams("tests=1"))).toEqual({ status: "all", tests: true });
  });

  it("never matches an unlabelled issue to a label filter", () => {
    expect(ids(filterIssues(issues, { status: "all", category: "server" }))).toEqual(["server", "old"]);
    expect(filterIssues(issues, { owner: "unknown" })).toEqual([]);
  });

  it("counts each option against the other filters, not its own", () => {
    expect(labelCounts(issues, { impact: "blocked", owner: "app" }, "owner")).toEqual(new Map([["app", 1], ["backend", 1]]));
    expect(labelCounts(issues, { impact: "blocked" }, "impact")).toEqual(new Map([["blocked", 2], ["degraded", 1]]));
  });

  it("reads filters from search params and drops unknown ids", () => {
    const q = new URLSearchParams("category=server&owner=nobody&impact=blocked");
    expect(labelFilterOf((k) => q.get(k))).toEqual({ category: "server", impact: "blocked" });
    expect(labelFilterOf(() => 3)).toEqual({});
  });

  it("reads /api/summary filters: every status by default, and rejects what it doesn't know", () => {
    const q = (s: string) => issueFilterFromQuery(new URLSearchParams(s));
    expect(q("")).toEqual({ status: "all" });
    expect(q("status=open&impact=blocked&owner=backend&flow=auth.login")).toEqual({ status: "open", flow: "auth.login", impact: "blocked", owner: "backend" });
    expect(q("status=opne")).toMatch(/^status must be one of open, resolved, ignored, all/);
    expect(q("owner=nobody")).toMatch(/^Unknown owner "nobody"/);
    const f = q("impact=blocked");
    expect(typeof f === "object" && ids(filterIssues(issues, f))).toEqual(["crash", "server"]);
  });
});
