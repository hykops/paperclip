import { describe, expect, it } from "vitest";
import {
  appendHistory,
  HISTORY_LIMIT,
  httpsRedirect,
  isApiPath,
  isGatewayPath,
  isOriginUnavailable,
  maintenanceResponse,
  offlineResponse,
  parseJson,
  sanitizeForwardHeaders,
  statusResponse,
  wantsHtml,
} from "./gateway.ts";

describe("path classification", () => {
  it("recognises gateway and api paths", () => {
    expect(isGatewayPath("/__gateway/status")).toBe(true);
    expect(isGatewayPath("/api/__gateway/status")).toBe(false);
    expect(isApiPath("/api")).toBe(true);
    expect(isApiPath("/api/health")).toBe(true);
    expect(isApiPath("/apiary")).toBe(false);
  });
});

describe("wantsHtml", () => {
  it("is true for browser navigations and false for api or json clients", () => {
    expect(
      wantsHtml(new Request("https://p.example/", { headers: { accept: "text/html,*/*" } })),
    ).toBe(true);
    expect(
      wantsHtml(new Request("https://p.example/api/health", { headers: { accept: "text/html" } })),
    ).toBe(false);
    expect(
      wantsHtml(new Request("https://p.example/", { headers: { accept: "application/json" } })),
    ).toBe(false);
  });
});

describe("sanitizeForwardHeaders", () => {
  it("drops spoofable trusted-proxy headers and pins the forwarded host", () => {
    const inbound = new Headers({
      cookie: "a=1",
      authorization: "Bearer agent-key",
      "x-paperclip-cloud-user-email": "evil@example.com",
      "x-paperclip-cloud-tenant-token": "token",
      "x-paperclip-gateway-stage": "forged",
      "x-paperclip-dev-server-status-token": "x",
      "x-forwarded-host": "attacker.example",
      "x-forwarded-proto": "http",
      forwarded: "host=attacker.example",
      "x-forwarded-for": "1.2.3.4, 203.0.113.9",
      "x-real-ip": "1.2.3.4",
      "true-client-ip": "1.2.3.4",
      "cf-connecting-ip": "203.0.113.9",
    });
    const out = sanitizeForwardHeaders(inbound, { stage: "prod", hostname: "p.example" });
    expect(out.get("cookie")).toBe("a=1");
    expect(out.get("authorization")).toBe("Bearer agent-key");
    expect(out.get("x-forwarded-host")).toBe("p.example");
    expect(out.get("x-forwarded-proto")).toBe("https");
    expect(out.get("forwarded")).toBeNull();
    expect(out.get("cf-connecting-ip")).toBe("203.0.113.9");
    expect(out.get("x-forwarded-for")).toBe("203.0.113.9");
    expect(out.get("x-real-ip")).toBeNull();
    expect(out.get("true-client-ip")).toBeNull();
    expect(out.get("x-paperclip-cloud-user-email")).toBeNull();
    expect(out.get("x-paperclip-cloud-tenant-token")).toBeNull();
    expect(out.get("x-paperclip-dev-server-status-token")).toBeNull();
    expect(out.get("x-paperclip-gateway-stage")).toBe("prod");
  });
  it("leaves x-forwarded-for unset when the edge did not supply a client ip", () => {
    const out = sanitizeForwardHeaders(new Headers({ "x-forwarded-for": "1.2.3.4" }), {
      stage: "prod",
      hostname: "p.example",
    });
    expect(out.get("x-forwarded-for")).toBeNull();
  });
});

describe("httpsRedirect", () => {
  it("sends plain-http requests to the https url, query included", () => {
    const res = httpsRedirect(new URL("http://p.example/api/auth/sign-in/email?x=1"));
    expect(res?.status).toBe(308);
    expect(res?.headers.get("location")).toBe("https://p.example/api/auth/sign-in/email?x=1");
  });
  it("is a no-op for https", () => {
    expect(httpsRedirect(new URL("https://p.example/"))).toBeNull();
  });
});

describe("isOriginUnavailable", () => {
  it("flags Cloudflare tunnel errors", () => {
    expect(isOriginUnavailable(new Response("", { status: 530 }))).toBe(true);
    expect(
      isOriginUnavailable(
        new Response("<html>", {
          status: 502,
          headers: { server: "cloudflare", "content-type": "text/html" },
        }),
      ),
    ).toBe(true);
  });
  it("passes Paperclip's own error responses through", () => {
    expect(
      isOriginUnavailable(
        new Response("{}", {
          status: 503,
          headers: { "content-type": "application/json", server: "cloudflare" },
        }),
      ),
    ).toBe(false);
    expect(
      isOriginUnavailable(
        new Response("{}", { status: 503, headers: { "content-type": "application/json" } }),
      ),
    ).toBe(false);
    expect(isOriginUnavailable(new Response("ok", { status: 200 }))).toBe(false);
    expect(isOriginUnavailable(new Response("nope", { status: 404 }))).toBe(false);
  });
});

describe("history", () => {
  it("prepends and caps the probe history", () => {
    const record = (i: number) => ({ at: `t${i}`, ok: true, status: 200, latencyMs: i });
    let history = appendHistory(undefined, record(0));
    for (let i = 1; i < HISTORY_LIMIT + 5; i++) history = appendHistory(history, record(i));
    expect(history).toHaveLength(HISTORY_LIMIT);
    expect(history[0].at).toBe(`t${HISTORY_LIMIT + 4}`);
  });
  it("parses json leniently", () => {
    expect(parseJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
    expect(parseJson("{broken")).toBeUndefined();
    expect(parseJson(null)).toBeUndefined();
  });
});

describe("responses", () => {
  const info = {
    hostname: "p.example",
    lastOk: { at: "2026-10-24T00:00:00Z", ok: true, status: 200, latencyMs: 12 },
    retryAfterSeconds: 15,
  };
  it("renders an html offline page for browsers and json for api clients", async () => {
    const html = offlineResponse(
      new Request("https://p.example/", { headers: { accept: "text/html" } }),
      info,
    );
    expect(html.status).toBe(503);
    expect(html.headers.get("retry-after")).toBe("15");
    expect(await html.text()).toContain("Paperclip is offline");
    const json = offlineResponse(new Request("https://p.example/api/health"), info);
    expect(json.headers.get("content-type")).toContain("application/json");
    expect(await json.json()).toMatchObject({ error: "origin_unavailable", lastOk: info.lastOk.at });
  });
  it("escapes operator notes on the maintenance page", async () => {
    const res = maintenanceResponse(
      new Request("https://p.example/", { headers: { accept: "text/html" } }),
      "p.example",
      "<script>x</script>",
    );
    const body = await res.text();
    expect(body).not.toContain("<script>x</script>");
    expect(body).toContain("&lt;script&gt;");
  });
  it("renders the status document without identity details", async () => {
    const res = statusResponse({
      stage: "prod",
      hostname: "p.example",
      maintenance: null,
      lastOk: undefined,
      lastFail: undefined,
      history: [],
    });
    const body = await res.json();
    expect(body).toMatchObject({ stage: "prod", maintenance: false, origin: { history: [] } });
    expect(body).not.toHaveProperty("identity");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
