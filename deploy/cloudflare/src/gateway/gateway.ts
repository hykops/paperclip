/**
 * Pure helpers for the gateway Worker: request classification, header
 * hygiene, origin-outage detection and the operator-facing status/offline
 * pages. Kept free of Worker bindings so vitest can cover them in Node.
 */

export const KV_KEYS = {
  /** Any value turns the maintenance page on. Set it with the Cloudflare KV editor. */
  maintenance: "gateway:maintenance",
  /** JSON `ProbeRecord` of the last successful origin probe. */
  lastOk: "origin:last-ok",
  /** JSON `ProbeRecord` of the last failed origin probe. */
  lastFail: "origin:last-fail",
  /** JSON array of the most recent `ProbeRecord`s, newest first. */
  history: "origin:history",
} as const;

export const HISTORY_LIMIT = 48;
export const GATEWAY_PREFIX = "/__gateway/";
/** Marks responses the gateway produced itself (never set on origin responses). */
export const GATEWAY_RESPONSE_HEADER = "x-paperclip-gateway";
export const GATEWAY_RESPONSE = { offline: "origin-unavailable", maintenance: "maintenance" } as const;

export interface ProbeRecord {
  readonly at: string;
  readonly ok: boolean;
  readonly status: number | null;
  readonly latencyMs: number;
  readonly note?: string;
}

export const isGatewayPath = (pathname: string): boolean => pathname.startsWith(GATEWAY_PREFIX);

export const isApiPath = (pathname: string): boolean =>
  pathname === "/api" || pathname.startsWith("/api/");

export const wantsHtml = (request: Request): boolean => {
  if (isApiPath(new URL(request.url).pathname)) return false;
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/html");
};

/** Spoofable trusted-proxy headers that must never reach the origin from a client. */
const STRIPPED_PREFIXES = ["x-paperclip-cloud-", "x-paperclip-gateway-"];
const STRIPPED_HEADERS = new Set([
  "x-paperclip-dev-server-status-token",
  // Paperclip consults these under TRUST_PROXY; the gateway pins them below.
  "x-forwarded-host",
  "x-forwarded-proto",
  "forwarded",
  // Client IP headers Paperclip or its auth library may read for rate limiting
  // and audit fields. Cloudflare appends the real IP to a client-supplied
  // x-forwarded-for instead of replacing it, so the chain is rebuilt below
  // from cf-connecting-ip, which the edge sets and a client cannot forge.
  "x-forwarded-for",
  "x-real-ip",
  "true-client-ip",
]);

/** 308 to the https:// form of a plain-HTTP request URL, or null when already https. */
export const httpsRedirect = (url: URL): Response | null => {
  if (url.protocol !== "http:") return null;
  const target = new URL(url);
  target.protocol = "https:";
  return new Response(null, {
    status: 308,
    headers: { location: target.toString(), "cache-control": "no-store" },
  });
};

export interface ForwardContext {
  readonly stage: string;
  /** Public hostname of the board; becomes the pinned `x-forwarded-host`. */
  readonly hostname: string;
}

/**
 * Copy the inbound headers for the origin request. Client-supplied headers that
 * Paperclip treats as trusted-proxy identity are removed, the forwarded host
 * and protocol are pinned to the board's public values, and the client IP is
 * taken from `cf-connecting-ip`. The gateway stage is attached as
 * `x-paperclip-gateway-stage` for the origin's logs; Paperclip does not read it
 * for authorization. Cookies and the Authorization header pass through
 * untouched, so Paperclip's own login keeps working end to end.
 */
export const sanitizeForwardHeaders = (headers: Headers, context: ForwardContext): Headers => {
  const out = new Headers();
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (STRIPPED_HEADERS.has(lower)) return;
    if (STRIPPED_PREFIXES.some((prefix) => lower.startsWith(prefix))) return;
    out.append(name, value);
  });
  out.set("x-forwarded-host", context.hostname);
  out.set("x-forwarded-proto", "https");
  const clientIp = headers.get("cf-connecting-ip");
  if (clientIp) out.set("x-forwarded-for", clientIp);
  out.set("x-paperclip-gateway-stage", context.stage);
  return out;
};

/**
 * Whether a response came from Cloudflare because the tunnel or origin is down,
 * as opposed to a response Paperclip itself produced. Paperclip's own error
 * responses are JSON; Cloudflare's tunnel errors (530 / 1033, 502 / 1016, 521,
 * 523, 524) are HTML served by the edge.
 */
export const isOriginUnavailable = (response: Response): boolean => {
  const status = response.status;
  if (status === 530 || status === 521 || status === 523 || status === 524) return true;
  if (status === 502 || status === 503 || status === 504) {
    const contentType = response.headers.get("content-type") ?? "";
    const server = response.headers.get("server") ?? "";
    return !contentType.includes("application/json") && server.toLowerCase() === "cloudflare";
  }
  return false;
};

export const parseJson = <T>(raw: string | null): T | undefined => {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
};

export const appendHistory = (
  existing: readonly ProbeRecord[] | undefined,
  record: ProbeRecord,
  limit = HISTORY_LIMIT,
): ProbeRecord[] => [record, ...(existing ?? [])].slice(0, limit);

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );

const page = (title: string, body: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,-apple-system,Segoe UI,sans-serif}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}
main{max-width:34rem;padding:2rem;line-height:1.5}
h1{font-size:1.25rem;margin:0 0 .5rem}
p{margin:.5rem 0}
code{font-size:.9em}
small{opacity:.7}
</style>
</head>
<body><main>${body}</main></body>
</html>`;

export interface OutageInfo {
  readonly hostname: string;
  readonly lastOk: ProbeRecord | undefined;
  readonly retryAfterSeconds: number;
}

export const offlineResponse = (request: Request, info: OutageInfo): Response => {
  const headers: Record<string, string> = {
    "retry-after": String(info.retryAfterSeconds),
    "cache-control": "no-store",
    [GATEWAY_RESPONSE_HEADER]: GATEWAY_RESPONSE.offline,
  };
  if (!wantsHtml(request)) {
    return Response.json(
      {
        error: "origin_unavailable",
        message: "Paperclip is not reachable through its tunnel right now.",
        lastOk: info.lastOk?.at ?? null,
      },
      { status: 503, headers },
    );
  }
  const lastSeen = info.lastOk
    ? `<p><small>Last healthy probe: <code>${escapeHtml(info.lastOk.at)}</code></small></p>`
    : "";
  return new Response(
    page(
      "Paperclip is offline",
      `<h1>Paperclip is offline</h1>
<p>The Cloudflare edge for <code>${escapeHtml(info.hostname)}</code> is up, but the server behind the tunnel is not answering. The machine may be restarting or the <code>cloudflared</code> container may be down.</p>
<p>This page refreshes automatically.</p>${lastSeen}
<script>setTimeout(function(){location.reload()}, ${info.retryAfterSeconds * 1000});</script>`,
    ),
    { status: 503, headers: { ...headers, "content-type": "text/html; charset=utf-8" } },
  );
};

export const maintenanceResponse = (request: Request, hostname: string, note: string): Response => {
  const headers: Record<string, string> = {
    "retry-after": "120",
    "cache-control": "no-store",
    [GATEWAY_RESPONSE_HEADER]: GATEWAY_RESPONSE.maintenance,
  };
  if (!wantsHtml(request)) {
    return Response.json(
      { error: "maintenance", message: "Paperclip is in maintenance mode.", note: note || null },
      { status: 503, headers },
    );
  }
  const detail = note ? `<p>${escapeHtml(note)}</p>` : "";
  return new Response(
    page(
      "Paperclip maintenance",
      `<h1>Paperclip is in maintenance mode</h1>
<p><code>${escapeHtml(hostname)}</code> is paused by its operator.</p>${detail}
<p><small>Clear the <code>${KV_KEYS.maintenance}</code> key in the gateway KV namespace to reopen it.</small></p>`,
    ),
    { status: 503, headers: { ...headers, "content-type": "text/html; charset=utf-8" } },
  );
};

/**
 * Public, unauthenticated document. It reveals only what anyone could learn by
 * requesting `/api/liveness` themselves: whether the origin answers, and when it
 * last did. Keep it that way; never add origin details here.
 */
export interface StatusInfo {
  readonly stage: string;
  readonly hostname: string;
  readonly maintenance: string | null;
  readonly lastOk: ProbeRecord | undefined;
  readonly lastFail: ProbeRecord | undefined;
  readonly history: readonly ProbeRecord[];
}

export const statusResponse = (info: StatusInfo): Response =>
  Response.json(
    {
      gateway: "paperclip-cloudflare-edge",
      stage: info.stage,
      hostname: info.hostname,
      maintenance: info.maintenance !== null,
      maintenanceNote: info.maintenance || null,
      origin: {
        lastOk: info.lastOk ?? null,
        lastFail: info.lastFail ?? null,
        history: info.history,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
