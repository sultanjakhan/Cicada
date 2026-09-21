import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import worker from "../src/worker.mjs";

const serviceDir = path.resolve(import.meta.dirname, "..");
const fixtureRoot = path.join(serviceDir, ".local", "test-assets");
const assetsDir = path.join(fixtureRoot, "update-assets");
const devVars = path.join(import.meta.dirname, ".dev.vars");
const config = path.join(import.meta.dirname, "wrangler.jsonc");
const wrangler = path.join(serviceDir, "node_modules", "wrangler", "bin", "wrangler.js");
const token = "test-only-update-token";

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitFor(url, child, output) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler dev exited with ${child.exitCode}: ${output.join("")}`);
    }
    try {
      const response = await fetch(url);
      if (response.status !== 503 || await response.text() !== "Service Unavailable") {
        return;
      }
    } catch {
      // The local Miniflare runtime is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for local Miniflare runtime");
}

async function terminate(child) {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

test("local Miniflare route protects all update assets", async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
  await mkdir(path.join(assetsDir, "releases"), { recursive: true });
  await writeFile(path.join(assetsDir, "latest.json"), '{"version":"0.3.3"}\n');
  await writeFile(path.join(assetsDir, "releases", "Hanni-MVP-0.3.3.apk"), "apk-fixture");
  await writeFile(devVars, `UPDATES_TOKEN=${token}\n`);

  const port = await freePort();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "hanni-mvp-update-state-"));
  const child = execFile(process.execPath, [wrangler, "dev", "--local", "--config", config, "--ip", "127.0.0.1", "--port", String(port), "--persist-to", stateRoot], {
    cwd: serviceDir,
    windowsHide: true,
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(`${base}/health`, child, output);

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "ok");
    assert.match(health.headers.get("cache-control"), /private, no-store/);

    for (const authorization of [undefined, "Bearer wrong"]) {
      const headers = authorization ? { Authorization: authorization } : {};
      const denied = await fetch(`${base}/latest.json`, { headers });
      assert.equal(denied.status, 401, "run_worker_first must protect direct assets");
    }

    const headers = { Authorization: `Bearer ${token}` };
    const manifest = await fetch(`${base}/latest.json`, { headers });
    assert.equal(manifest.status, 200);
    assert.equal(await manifest.text(), '{"version":"0.3.3"}\n');

    const head = await fetch(`${base}/latest.json`, { method: "HEAD", headers });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");

    const range = await fetch(`${base}/releases/Hanni-MVP-0.3.3.apk`, {
      headers: { ...headers, Range: "bytes=0-2" },
    });
    assert.equal(range.status, 200, "the local Static Assets runtime serves the unchanged full asset");
    assert.equal(await range.text(), "apk-fixture");

    const unknown = await fetch(`${base}/releases/`, { headers });
    assert.equal(unknown.status, 404);
    const write = await fetch(`${base}/latest.json`, { method: "POST" });
    assert.equal(write.status, 405);
    assert.equal(write.headers.get("allow"), "GET, HEAD");
  } finally {
    await terminate(child);
    await rm(devVars, { force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test("test runner leaves no local asset or secret fixture", async () => {
  const { access } = await import("node:fs/promises");
  assert.equal(await access(devVars).then(() => true, () => false), false);
  assert.equal(await access(fixtureRoot).then(() => true, () => false), false);
});

test("missing secret fails closed before the assets binding", async () => {
  const response = await worker.fetch(new Request("https://updates.example/latest.json"), {
    ASSETS: { fetch: () => { throw new Error("assets must not be reached"); } },
  });
  assert.equal(response.status, 503);
});

test("origin-only feed clients retain authentication, HEAD and private responses without redirects", async (t) => {
  const previous = crypto.subtle.timingSafeEqual;
  crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
  t.after(() => {
    if (previous === undefined) delete crypto.subtle.timingSafeEqual;
    else crypto.subtle.timingSafeEqual = previous;
  });
  const received = [];
  const env = {
    UPDATES_TOKEN: token,
    ASSETS: { fetch(request) {
      received.push(request);
      return new Response(request.method === "HEAD" ? null : '{"version":"0.3.17"}');
    } },
  };
  for (const endpoint of ["/", "/latest.json"]) {
    for (const authorization of [undefined, "Bearer wrong"]) {
      const headers = authorization ? { Authorization: authorization } : {};
      const denied = await worker.fetch(new Request(`https://updates.example${endpoint}`, { headers }), env);
      assert.equal(denied.status, 401);
    }
  }
  assert.equal(received.length, 0, "unauthorized requests never reach assets");
  for (const method of ["GET", "HEAD"]) {
    const response = await worker.fetch(new Request("https://updates.example/", {
      method, headers: { Authorization: `Bearer ${token}` },
    }), env);
    const request = received.at(-1);
    assert.equal(new URL(request.url).pathname, "/latest.json");
    assert.equal(request.method, method);
    assert.equal(request.headers.has("authorization"), false);
    assert.equal(response.status, 200);
    assert.equal(response.headers.has("location"), false);
    assert.match(response.headers.get("cache-control"), /private, no-store/);
    assert.equal(await response.text(), method === "HEAD" ? "" : '{"version":"0.3.17"}');
  }
});
