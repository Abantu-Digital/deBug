import { describe, expect, it } from "vitest";
import { bodyView, curlOf } from "./exchange-view";

describe("body view", () => {
  it("pretty-prints JSON and keeps the body as it came", () => {
    expect(bodyView({ body: '{"a":1,"b":[2]}' })).toMatchObject({ text: '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}', raw: '{"a":1,"b":[2]}', json: true, cut: false, note: undefined });
  });
  it("says when the SDK or ingest cut the body, in characters, and shows the cut text as it came", () => {
    expect(bodyView({ body: '{"items":[1,2…[truncated, 48 KB total]', truncated: true, bodySize: 49_152 })).toMatchObject({ json: false, cut: true, text: '{"items":[1,2', note: "Cut after 13 characters of 48 KB: the rest wasn't captured." });
    expect(bodyView({ body: "abc…[truncated]", bodySize: 20_000 })!.note).toBe("Cut after 3 characters of 20,000 characters: the rest wasn't captured.");
  });
  it("notes a binary body in each form the SDK writes it", () => {
    expect(bodyView({ body: "[binary 12 KB, image/png]" })).toMatchObject({ binary: true, text: "", note: "Binary, 12 KB (image/png): not captured." });
    expect(bodyView({ body: "[binary, multipart/form-data]" })!.note).toBe("Binary (multipart/form-data): not captured.");
    expect(bodyView({ body: "[binary 4 KB]" })!.note).toBe("Binary, 4 KB: not captured.");
    expect(bodyView({ body: "[binary]", bodySize: 2048 })!.note).toBe("Binary, 2 KB: not captured.");
  });
  it("is undefined when no body was captured", () => {
    expect(bodyView({ headers: { a: "b" } })).toBeUndefined();
  });
});

describe("copy as cURL", () => {
  const base = { method: "POST", url: "api.x/buy/with-airtime", headers: { "content-type": "application/json", authorization: "[redacted]" }, body: '{"amount": 50, "id": 12345678901234567890, "note": "it\'s"}' };
  it("quotes everything, sends the body exactly as captured, and says it's redacted", () => {
    const { command, complete } = curlOf({ request: { ...base, fullUrl: "https://api.x/buy/with-airtime", query: "a=1" } });
    expect(command.split("\n")).toEqual([
      "# From deBug, as captured: secrets show as [redacted].",
      "curl -X 'POST' 'https://api.x/buy/with-airtime?a=1' \\",
      "  -H 'content-type: application/json' \\",
      "  -H 'authorization: [redacted]' \\",
      `  --data-raw '{"amount": 50, "id": 12345678901234567890, "note": "it'\\''s"}'`,
    ]);
    expect(complete).toBe(false);
  });
  it("can't be made to run anything else", () => {
    const { command } = curlOf({ request: { method: "X;RM -RF ~", url: "/x", headers: { "x-a": "$(id)`id`\n" } } });
    expect(command).toContain("curl -X 'X;RM -RF ~' 'https://HOST/x'");
    expect(command).toContain("-H 'x-a: $(id)`id`\n'");
  });
  it("leaves HOST to fill in for a path-only call, and says what else was masked or left out", () => {
    const { command } = curlOf({ request: { method: "GET", url: "/v1/orders/:id", query: "q=abc…[truncated]", body: "[binary 3 KB, application/pdf]" } });
    expect(command).toBe("# From deBug, as captured: ids in the path show as :id; replace HOST; the query was cut; the binary body wasn't captured.\ncurl -X 'GET' 'https://HOST/v1/orders/:id?q=abc'");
  });
  it("is complete when nothing was redacted or left out", () => {
    expect(curlOf({ request: { method: "GET", url: "api.x/y", fullUrl: "https://api.x/y", headers: { accept: "*/*" } } })).toEqual({ command: "curl -X 'GET' 'https://api.x/y' \\\n  -H 'accept: */*'", complete: true });
  });
});
