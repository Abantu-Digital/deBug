import { describe, expect, it } from "vitest";
import type { Classification, StoredEvent } from "@debugkit/schema";
import { areaOf } from "./queries";

const labels = (category: string) => ({ category, causes: [], owner: "backend", impact: "degraded" }) as unknown as Classification;
const failed = (url: string) => ({ event: { type: "error", id: "e", ts: "2026-11-18T10:00:00Z", error: { name: "HttpError", message: "x" }, request: { method: "GET", url, status: 404 } } }) as unknown as StoredEvent;

describe("areaOf: where an issue sits under Health", () => {
  it("puts crashes and code errors under App code", () => {
    expect(areaOf(undefined, labels("uncaught"), [])).toEqual({ kind: "app" });
  });

  it("puts a failed call under its service, named in Settings", () => {
    const hosts = [{ match: "api.example.com/ppd/api/billing", name: "Billing" }];
    expect(areaOf(failed("https://api.example.com/ppd/api/billing/get-bill"), labels("client_request"), hosts as never)).toEqual({ kind: "service", name: "Billing" });
  });

  it("has nowhere to put a failed call whose service nobody named", () => {
    expect(areaOf(failed("https://unknown.example.com/x"), labels("server"), [])).toBeNull();
  });
});
