import { describe, expect, it } from "vitest";
import type { StoredEvent } from "@debugkit/schema";
import { callsOf } from "./queries";

const URL = "api.example.com/ppd/api/balance/getBalances";
const at = (id: string) => `2026-11-18T10:00:0${id}Z`;
/** A failed call: answered with a body, captured with no answer (timed out), or nothing captured. */
const answered = (id: string) =>
  ({ sessionId: "s", event: { type: "error", id, ts: at(id), error: { name: "HttpError", message: "x" }, request: { method: "POST", url: URL, status: 404, headers: { "x-api-key": "[redacted]" } }, response: { status: 404, body: '{"title":"Balance lookup unsuccessful"}' } } }) as unknown as StoredEvent;
const timedOut = (id: string) =>
  ({ sessionId: "s", event: { type: "error", id, ts: at(id), error: { name: "NetworkError", message: "timed out" }, request: { method: "POST", url: URL, headers: { "x-api-key": "[redacted]" } } } }) as unknown as StoredEvent;
const bare = (id: string) => ({ sessionId: "s", event: { type: "error", id, ts: at(id), error: { name: "HttpError", message: "x" }, request: { method: "POST", url: URL, status: 404 } } }) as unknown as StoredEvent;

describe("callsOf: the failed call an issue page shows", () => {
  it("shows the newest call, and the last answer when the newest got none (an outage)", () => {
    const c = callsOf([timedOut("3"), answered("2"), answered("1")], []);
    expect(c.latest).toMatchObject({ eventId: "3" });
    expect(c.latest?.exchange?.response).toBeUndefined();
    expect(c.lastAnswer).toMatchObject({ eventId: "2" });
    expect(c.lastAnswer?.exchange?.response?.body).toContain("Balance lookup unsuccessful");
  });

  it("needs no second card when the newest was answered", () => {
    expect(callsOf([answered("2"), timedOut("1")], [])).toEqual({ latest: expect.objectContaining({ eventId: "2" }), lastAnswer: undefined });
  });

  it("prefers an occurrence that captured something over a newer one that didn't", () => {
    expect(callsOf([bare("3"), answered("2")], []).latest).toMatchObject({ eventId: "2" });
    expect(callsOf([bare("2"), bare("1")], []).latest).toMatchObject({ eventId: "2", exchange: undefined });
  });

  it("has nothing for an error that isn't a failed call", () => {
    const crash = { sessionId: "s", event: { type: "error", id: "9", ts: at("9"), error: { name: "TypeError", message: "x" } } } as unknown as StoredEvent;
    expect(callsOf([crash], [])).toEqual({ latest: undefined, lastAnswer: undefined });
  });
});
