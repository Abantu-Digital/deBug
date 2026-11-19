import { describe, expect, it } from "vitest";
import { hostKindLabel, hostKindOf, hostNameFor, nameUrl, nameUrlsIn, normaliseHostMatch, validHostNames, type HostName } from "./hosts";

const GATEWAY = "2qpssug3bh.execute-api.af-south-1.amazonaws.com";
const hosts: HostName[] = [
  { match: GATEWAY, name: "Cell C API", owner: "backend" },
  { match: `${GATEWAY}/prod/api/balance`, name: "Balance service", owner: "backend" },
  { match: "maps.googleapis.com", name: "Google Maps", owner: "third_party" },
];

describe("host names", () => {
  it("cleans what people paste", () => {
    expect(normaliseHostMatch("https://API.Example.com/Payments/?x=1")).toBe("api.example.com/Payments");
    expect(normaliseHostMatch("  api.example.com  ")).toBe("api.example.com");
  });

  it("the longest match wins, on whole path segments", () => {
    expect(hostNameFor(`${GATEWAY}/prod/api/balance/getBalances`, hosts)).toEqual({ host: hosts[1], rest: "/getBalances" });
    expect(hostNameFor(`${GATEWAY}/prod/api/balances-v2`, hosts)?.host.name).toBe("Cell C API");
    expect(hostNameFor(`${GATEWAY}`, hosts)).toEqual({ host: hosts[0], rest: "" });
    expect(hostNameFor(`${GATEWAY}:443/prod`, hosts)).toEqual({ host: hosts[0], rest: "/prod" });
    expect(hostNameFor("api.example.com/x", hosts)).toBeUndefined();
    expect(hostNameFor(`x${GATEWAY}/prod`, hosts)).toBeUndefined();
  });

  it("names URLs, alone and inside titles and endpoint keys", () => {
    expect(nameUrl(`${GATEWAY}/prod/api/balance/getBalances`, hosts)).toBe("Balance service · /getBalances");
    expect(nameUrl("maps.googleapis.com", hosts)).toBe("Google Maps");
    expect(nameUrlsIn(`NetworkError: POST ${GATEWAY}/prod/api/balance/getBalances failed`, hosts)).toBe("NetworkError: POST Balance service · /getBalances failed");
    expect(nameUrlsIn(`GET https://maps.googleapis.com/geocode responded 503`, hosts)).toBe("GET Google Maps · /geocode responded 503");
    expect(nameUrlsIn("Cannot read property 'x' of undefined", hosts)).toBe("Cannot read property 'x' of undefined");
    expect(nameUrlsIn(`GET ${GATEWAY}/x`, [])).toBe(`GET ${GATEWAY}/x`);
  });

  it("review fixes: keeps queries, ignores ports, leaves emails alone", () => {
    expect(nameUrlsIn(`GET ${GATEWAY}/prod/api/balance/x?page=2 failed`, hosts)).toBe("GET Balance service · /x?page=2 failed");
    expect(hostNameFor(`${GATEWAY}:443/prod/api/balance/x`, hosts)?.host.name).toBe("Balance service");
    expect(nameUrlsIn("No account for support@maps.googleapis.com", hosts)).toBe("No account for support@maps.googleapis.com");
    expect(validHostNames([{ match: "localhost", name: "Local" }])).toMatch(/isn't a host/);
    expect(validHostNames([{ match: "api.x.com", name: "A", owner: "unknown" }])).toMatch(/owner/);
    expect(validHostNames([{ match: "api.x.com:8443/v1", name: "A" }])).toEqual([{ match: "api.x.com/v1", name: "A" }]);
  });

  it("validates Settings: skips empty rows, rejects bad hosts, names, owners and repeats", () => {
    expect(validHostNames([{ match: "https://api.x.com/", name: " Accounts ", owner: "backend" }, { match: "", name: "" }])).toEqual([{ match: "api.x.com", name: "Accounts", owner: "backend" }]);
    expect(validHostNames([{ match: "api.x.com", name: "A", owner: "" }])).toEqual([{ match: "api.x.com", name: "A" }]);
    expect(validHostNames("nope")).toMatch(/list/);
    expect(validHostNames([{ match: "not a host", name: "A" }])).toMatch(/isn't a host/);
    expect(validHostNames([{ match: "api.x.com", name: "" }])).toMatch(/name/);
    expect(validHostNames([{ match: "api.x.com", name: "A", owner: "boss" }])).toMatch(/owner/);
    expect(validHostNames([{ match: "api.x.com", name: "A" }, { match: "API.x.com", name: "B" }])).toMatch(/twice/);
    expect(validHostNames(Array.from({ length: 51 }, (_, i) => ({ match: `h${i}.x.com`, name: "A" })))).toMatch(/50/);
  });

  it("marks a host, or part of one, as ours or upstream, and keeps a provider for upstream only", () => {
    expect(validHostNames([{ match: `${GATEWAY}/prod/ppd`, name: "Balance", kind: "upstream", provider: " Cell C " }])).toEqual([{ match: `${GATEWAY}/prod/ppd`, name: "Balance", kind: "upstream", provider: "Cell C" }]);
    expect(validHostNames([{ match: GATEWAY, name: "API", kind: "ours", provider: "Cell C" }])).toEqual([{ match: GATEWAY, name: "API", kind: "ours" }]);
    expect(validHostNames([{ match: GATEWAY, name: "API", kind: "" }])).toEqual([{ match: GATEWAY, name: "API" }]);
    expect(validHostNames([{ match: GATEWAY, name: "API", kind: "theirs" }])).toMatch(/kind/);
    expect(validHostNames([{ match: GATEWAY, name: "API", kind: "upstream", provider: "x".repeat(41) }])).toMatch(/40/);
  });

  it("works out whose service a host is from its owner when not set, and names it", () => {
    expect(hostKindOf({ kind: "upstream", owner: "backend" })).toBe("upstream");
    expect(hostKindOf({ owner: "third_party" })).toBe("upstream");
    expect(hostKindOf({ owner: "backend" })).toBe("ours");
    expect(hostKindOf({ owner: "infrastructure" })).toBe("ours");
    expect(hostKindOf({ owner: "app" })).toBeUndefined();
    expect(hostKindOf(undefined)).toBeUndefined();
    expect(hostKindLabel("upstream", "Cell C")).toBe("Cell C service");
    expect(hostKindLabel("upstream")).toBe("Third-party service");
    expect(hostKindLabel("ours", "Cell C")).toBe("Our backend");
  });
});
