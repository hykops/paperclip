/**
 * Paperclip Cloudflare gateway Worker.
 *
 * Runs on the board hostname in front of the Cloudflare Tunnel that reaches the
 * self-hosted Paperclip server. Paperclip's own account system is the login;
 * this Worker makes no authorization decision and forwards cookies and
 * Authorization headers untouched. It redirects plain HTTP to HTTPS, exposes a
 * small status surface backed by KV, serves maintenance and outage pages, and
 * probes the origin on a schedule so the status page can show tunnel history.
 *
 * KV is not essential on the request path: when it is unavailable the gateway
 * behaves as if there were no maintenance flag and no probe history, rather
 * than failing every request with a Worker exception.
 */
import {
  appendHistory,
  GATEWAY_RESPONSE,
  GATEWAY_RESPONSE_HEADER,
  httpsRedirect,
  isGatewayPath,
  isOriginUnavailable,
  KV_KEYS,
  maintenanceResponse,
  offlineResponse,
  parseJson,
  sanitizeForwardHeaders,
  statusResponse,
  type ProbeRecord,
} from "./gateway.ts";

export interface Env {
  readonly GATEWAY_KV: KVNamespace;
  readonly PAPERCLIP_HOSTNAME: string;
  readonly GATEWAY_STAGE: string;
  /** Path the scheduled probe requests. Defaults to /api/liveness. */
  readonly GATEWAY_PROBE_PATH?: string;
}

const OUTAGE_RETRY_SECONDS = 15;
const PROBE_TIMEOUT_MS = 20_000;
const DEFAULT_PROBE_PATH = "/api/liveness";

/** KV read that falls open: a failure reads as "key absent". */
const kvGet = async (kv: KVNamespace, key: string): Promise<string | null> => {
  try {
    return await kv.get(key);
  } catch {
    return null;
  }
};

const readProbe = async (kv: KVNamespace, key: string) =>
  parseJson<ProbeRecord>(await kvGet(kv, key));

const forwardToOrigin = async (request: Request, env: Env): Promise<Response> => {
  const headers = sanitizeForwardHeaders(request.headers, {
    stage: env.GATEWAY_STAGE,
    hostname: env.PAPERCLIP_HOSTNAME,
  });
  // Same-zone subrequests go straight to the origin (the tunnel); Cloudflare
  // does not re-run this Worker for them. WebSocket upgrades are returned as
  // the 101 response the origin produced.
  const originRequest = new Request(request, { headers, redirect: "manual" });
  let response: Response;
  try {
    response = await fetch(originRequest);
  } catch {
    return offlineResponse(request, {
      hostname: env.PAPERCLIP_HOSTNAME,
      lastOk: await readProbe(env.GATEWAY_KV, KV_KEYS.lastOk),
      retryAfterSeconds: OUTAGE_RETRY_SECONDS,
    });
  }
  if (isOriginUnavailable(response)) {
    return offlineResponse(request, {
      hostname: env.PAPERCLIP_HOSTNAME,
      lastOk: await readProbe(env.GATEWAY_KV, KV_KEYS.lastOk),
      retryAfterSeconds: OUTAGE_RETRY_SECONDS,
    });
  }
  return response;
};

const handleGatewayPath = async (pathname: string, env: Env): Promise<Response> => {
  if (pathname === "/__gateway/status") {
    const [maintenance, lastOk, lastFail, history] = await Promise.all([
      kvGet(env.GATEWAY_KV, KV_KEYS.maintenance),
      readProbe(env.GATEWAY_KV, KV_KEYS.lastOk),
      readProbe(env.GATEWAY_KV, KV_KEYS.lastFail),
      kvGet(env.GATEWAY_KV, KV_KEYS.history).then((raw) => parseJson<ProbeRecord[]>(raw) ?? []),
    ]);
    return statusResponse({
      stage: env.GATEWAY_STAGE,
      hostname: env.PAPERCLIP_HOSTNAME,
      maintenance,
      lastOk,
      lastFail,
      history,
    });
  }
  return Response.json(
    { error: "not_found" },
    { status: 404, headers: { "cache-control": "no-store" } },
  );
};

/**
 * Probe the origin through the public hostname. A cron invocation has no zone
 * request context, so this request may be routed through this very Worker
 * (which then forwards it to the origin; there is no loop). The gateway's own
 * responses are recognised by their marker header so they are not mistaken for
 * Paperclip answering. Returns null when there is nothing to record.
 */
const probeOrigin = async (env: Env): Promise<ProbeRecord | null> => {
  const startedAt = Date.now();
  try {
    const probePath = env.GATEWAY_PROBE_PATH || DEFAULT_PROBE_PATH;
    const response = await fetch(`https://${env.PAPERCLIP_HOSTNAME}${probePath}`, {
      headers: { accept: "application/json", "user-agent": "paperclip-gateway-probe" },
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - startedAt;
    const at = new Date().toISOString();
    const viaGateway = response.headers.get(GATEWAY_RESPONSE_HEADER);
    // Maintenance mode answers for the origin; that says nothing about the tunnel.
    if (viaGateway === GATEWAY_RESPONSE.maintenance) return null;
    if (viaGateway === GATEWAY_RESPONSE.offline || isOriginUnavailable(response)) {
      return { at, ok: false, status: response.status, latencyMs, note: "origin unavailable" };
    }
    // Liveness answers 503 "starting" until the server finished booting.
    return { at, ok: response.ok, status: response.status, latencyMs };
  } catch (error) {
    return {
      at: new Date().toISOString(),
      ok: false,
      status: null,
      latencyMs: Date.now() - startedAt,
      note: error instanceof Error ? error.message : "probe failed",
    };
  }
};

const recordProbe = async (env: Env, record: ProbeRecord): Promise<void> => {
  const history = appendHistory(
    parseJson<ProbeRecord[]>(await kvGet(env.GATEWAY_KV, KV_KEYS.history)),
    record,
  );
  await Promise.all([
    env.GATEWAY_KV.put(KV_KEYS.history, JSON.stringify(history)),
    env.GATEWAY_KV.put(record.ok ? KV_KEYS.lastOk : KV_KEYS.lastFail, JSON.stringify(record)),
  ]);
};

const runScheduledProbe = async (env: Env): Promise<void> => {
  // In maintenance the probe could only ever see the gateway's own 503.
  if ((await kvGet(env.GATEWAY_KV, KV_KEYS.maintenance)) !== null) return;
  const record = await probeOrigin(env);
  if (record) await recordProbe(env, record);
};

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname !== env.PAPERCLIP_HOSTNAME) {
      return Response.json({ error: "unknown_host" }, { status: 404 });
    }

    // The route matches both schemes; never let a session cookie travel over
    // plain HTTP looking like TLS to the origin.
    const redirect = httpsRedirect(url);
    if (redirect) return redirect;

    if (isGatewayPath(url.pathname)) return handleGatewayPath(url.pathname, env);

    const maintenance = await kvGet(env.GATEWAY_KV, KV_KEYS.maintenance);
    if (maintenance !== null) {
      return maintenanceResponse(request, env.PAPERCLIP_HOSTNAME, maintenance);
    }

    return forwardToOrigin(request, env);
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(runScheduledProbe(env));
  },
} satisfies ExportedHandler<Env>;
