const encoder = new TextEncoder();

const releasePath = /^\/releases\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

function privateHeaders(source) {
  const headers = new Headers(source);
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set("Pragma", "no-cache");
  return headers;
}

function response(status, text) {
  return new Response(text, {
    status,
    headers: privateHeaders(),
  });
}

async function tokenMatches(provided, expected) {
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

function allowedPath(pathname) {
  return pathname === "/" || pathname === "/latest.json" || releasePath.test(pathname);
}

export default {
  async fetch(request, env) {
    if (!env.UPDATES_TOKEN) {
      return response(503, "Update service is not configured.");
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      const headers = privateHeaders();
      headers.set("Allow", "GET, HEAD");
      return new Response("Method not allowed.", {
        status: 405,
        headers,
      });
    }

    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("ok", { headers: privateHeaders() });
    }

    if (!allowedPath(url.pathname)) {
      return response(404, "Not found.");
    }

    const authorization = request.headers.get("Authorization") ?? "";
    if (!(await tokenMatches(authorization, `Bearer ${env.UPDATES_TOKEN}`))) {
      return response(401, "Unauthorized.");
    }

    const headers = new Headers(request.headers);
    headers.delete("Authorization");
    // Shipped clients may store only the origin as their feed URL. Resolve it
    // internally because native updaters deliberately refuse redirects.
    if (url.pathname === "/") url.pathname = "/latest.json";
    const assetRequest = new Request(url, { method: request.method, headers });
    const asset = await env.ASSETS.fetch(assetRequest);
    if (asset.status === 404) {
      return response(404, "Not found.");
    }

    return new Response(asset.body, {
      status: asset.status,
      statusText: asset.statusText,
      headers: privateHeaders(asset.headers),
    });
  },
};
