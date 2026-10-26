import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./worker.ts";
import { KV_KEYS } from "./gateway.ts";

const HOST = "p.example";

/** workers-types gives incoming requests a richer `cf` type than Node's Request carries. */
type IncomingRequest = Parameters<typeof worker.fetch>[0];
const incoming = (url: string, init?: RequestInit): IncomingRequest =>
  new Request(url, init) as unknown as IncomingRequest;

const makeKv = (overrides: Partial<{ get: (key: string) => Promise<string | null> }> = {}) => {
  const store = new Map<string, string>();
  const kv = {
    get: vi.fn(overrides.get ?? (async (key: string) => store.get(key) ?? null)),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
  return { kv: kv as unknown as KVNamespace, store, calls: kv };
};

const env = (kv: KVNamespace): Env => ({
  GATEWAY_KV: kv,
  PAPERCLIP_HOSTNAME: HOST,
  GATEWAY_STAGE: "test",
});

const fetchSpy = (impl: (request: Request) => Promise<Response> | Response) => {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return impl(request);
  });
  vi.stubGlobal("fetch", spy);
  return spy;
};

const scheduled = async (e: Env) => {
  const pending: Promise<unknown>[] = [];
  await worker.scheduled(
    {} as ScheduledController,
    e,
    {
      waitUntil: (p: Promise<unknown>) => pending.push(p),
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
  );
  await Promise.all(pending);
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetch handler", () => {
  it("rejects other hostnames", async () => {
    const { kv } = makeKv();
    const res = await worker.fetch(incoming("https://other.example/"), env(kv));
    expect(res.status).toBe(404);
  });

  it("redirects plain http to https before touching KV or the origin", async () => {
    const { kv, calls } = makeKv();
    const origin = fetchSpy(() => new Response("ok"));
    const res = await worker.fetch(incoming(`http://${HOST}/board?x=1`), env(kv));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`https://${HOST}/board?x=1`);
    expect(calls.get).not.toHaveBeenCalled();
    expect(origin).not.toHaveBeenCalled();
  });

  it("forwards with sanitised headers and passes the origin response through", async () => {
    const { kv } = makeKv();
    let seen: Request | undefined;
    fetchSpy((request) => {
      seen = request;
      return new Response("hello", { status: 200, headers: { "x-origin": "1" } });
    });
    const res = await worker.fetch(
      incoming(`https://${HOST}/api/companies`, {
        headers: {
          cookie: "s=1",
          "x-forwarded-for": "6.6.6.6, 203.0.113.9",
          "x-paperclip-cloud-user-email": "evil@example.com",
          "cf-connecting-ip": "203.0.113.9",
        },
      }),
      env(kv),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    expect(seen?.headers.get("cookie")).toBe("s=1");
    expect(seen?.headers.get("x-forwarded-for")).toBe("203.0.113.9");
    expect(seen?.headers.get("x-forwarded-host")).toBe(HOST);
    expect(seen?.headers.get("x-paperclip-cloud-user-email")).toBeNull();
    expect(seen?.headers.get("x-paperclip-gateway-stage")).toBe("test");
  });

  it("falls open to the origin when KV is unavailable", async () => {
    const { kv } = makeKv({ get: async () => { throw new Error("KV quota exceeded"); } });
    const origin = fetchSpy(() => new Response("ok"));
    const res = await worker.fetch(incoming(`https://${HOST}/`), env(kv));
    expect(res.status).toBe(200);
    expect(origin).toHaveBeenCalledTimes(1);
  });

  it("serves the maintenance page without contacting the origin", async () => {
    const { kv, store } = makeKv();
    store.set(KV_KEYS.maintenance, "db upgrade");
    const origin = fetchSpy(() => new Response("ok"));
    const res = await worker.fetch(incoming(`https://${HOST}/api/health`), env(kv));
    expect(res.status).toBe(503);
    expect(res.headers.get("x-paperclip-gateway")).toBe("maintenance");
    expect(await res.json()).toMatchObject({ error: "maintenance", note: "db upgrade" });
    expect(origin).not.toHaveBeenCalled();
  });

  it("turns a tunnel failure into the offline page", async () => {
    const { kv } = makeKv();
    fetchSpy(() => {
      throw new TypeError("fetch failed");
    });
    const res = await worker.fetch(incoming(`https://${HOST}/api/health`), env(kv));
    expect(res.status).toBe(503);
    expect(res.headers.get("x-paperclip-gateway")).toBe("origin-unavailable");
  });

  it("answers the status endpoint even when KV fails", async () => {
    const { kv } = makeKv({ get: async () => { throw new Error("KV down"); } });
    const res = await worker.fetch(incoming(`https://${HOST}/__gateway/status`), env(kv));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ maintenance: false, origin: { lastOk: null, history: [] } });
  });
});

describe("scheduled probe", () => {
  it("records a healthy probe", async () => {
    const { kv, store } = makeKv();
    fetchSpy(() => Response.json({ status: "ok" }, { status: 200 }));
    await scheduled(env(kv));
    expect(JSON.parse(store.get(KV_KEYS.lastOk) ?? "null")).toMatchObject({ ok: true, status: 200 });
    expect(JSON.parse(store.get(KV_KEYS.history) ?? "[]")).toHaveLength(1);
  });

  it("skips the probe while maintenance is on", async () => {
    const { kv, store } = makeKv();
    store.set(KV_KEYS.maintenance, "1");
    const origin = fetchSpy(() => new Response("ok"));
    await scheduled(env(kv));
    expect(origin).not.toHaveBeenCalled();
    expect(store.has(KV_KEYS.history)).toBe(false);
  });

  it("recognises the gateway's own offline page as an origin failure", async () => {
    const { kv, store } = makeKv();
    fetchSpy(() =>
      Response.json({ error: "origin_unavailable" }, { status: 503, headers: { "x-paperclip-gateway": "origin-unavailable" } }),
    );
    await scheduled(env(kv));
    expect(JSON.parse(store.get(KV_KEYS.lastFail) ?? "null")).toMatchObject({ ok: false, note: "origin unavailable" });
  });

  it("records nothing when the probe raced into maintenance mode", async () => {
    const { kv, store } = makeKv();
    fetchSpy(() => Response.json({ error: "maintenance" }, { status: 503, headers: { "x-paperclip-gateway": "maintenance" } }));
    await scheduled(env(kv));
    expect(store.has(KV_KEYS.history)).toBe(false);
  });
});
