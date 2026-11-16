import { describe, expect, it } from "vitest";
import { bodyView, curlOf } from "./exchange-view";

describe("body view", () => {
  it("pretty-prints JSON", () => {
    expect(bodyView({ body: '{"a":1,"b":[2]}' })).toEqual({ text: '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}', json: true, note: undefined });
  });
  it("says when the SDK or ingest cut the body, and shows the cut text as it came", () => {
    const sdk = bodyView({ body: '{"items":[1,2…[truncated, 48 KB total]', truncated: true, bodySize: 49_152 })!;
    expect(sdk).toMatchObject({ json: false, text: '{"items":[1,2', note: expect.stringMatching(/^Cut at .* of 48 KB/) });
    expect(bodyView({ body: "abc…[truncated]", truncated: true, bodySize: 20_000 })!.note).toMatch(/of 20 KB/);
  });
  it("notes a binary body instead of showing it", () => {
    expect(bodyView({ body: "[binary 12 KB, image/png]", bodySize: 12_288 })).toEqual({ text: "", json: false, note: "Binary, 12 KB (image/png). Not captured." });
  });
  it("is undefined when no body was captured", () => {
    expect(bodyView({ headers: { a: "b" } })).toBeUndefined();
  });
});

describe("copy as cURL", () => {
  const base = { method: "POST", url: "/buy/with-airtime", headers: { "content-type": "application/json", authorization: "[redacted]" }, body: '{"amount": 50, "note": "it\'s"}' };
  it("builds the command from the whole URL, the query, the headers and the body, and says it's redacted", () => {
    const { command, complete } = curlOf({ request: { ...base, fullUrl: "https://api.x/buy/with-airtime", query: "a=1" } });
    expect(command.split("\n")).toEqual([
      "# Redacted by deBug: secrets are [redacted].",
      "curl -X POST 'https://api.x/buy/with-airtime?a=1' \\",
      "  -H 'content-type: application/json' \\",
      "  -H 'authorization: [redacted]' \\",
      `  --data-raw '{"amount":50,"note":"it'\\''s"}'`,
    ]);
    expect(complete).toBe(false);
  });
  it("leaves a HOST to fill in when the SDK named the call by its path, and no body when it was binary", () => {
    const { command } = curlOf({ request: { method: "GET", url: "/x", body: "[binary 3 KB, application/pdf]" } });
    expect(command).toBe("# Redacted by deBug: replace HOST; the body was binary.\ncurl -X GET 'https://HOST/x'");
  });
  it("is complete when nothing was redacted or left out", () => {
    expect(curlOf({ request: { method: "GET", url: "https://api.x/y", headers: { accept: "*/*" } } })).toEqual({ command: "curl -X GET 'https://api.x/y' \\\n  -H 'accept: */*'", complete: true });
  });
});
