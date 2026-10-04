// R2 latency test: serves a page that times GETs from the browser to R2,
// both straight to R2's S3 endpoint (presigned URLs) and through this
// Worker's R2 binding.

import page from "./page.html";

// Objects the page reads. Sizes in bytes.
const SIZES = { "4k": 4 * 1024, "64k": 64 * 1024, "1m": 1024 * 1024, "8m": 8 * 1024 * 1024 };
// Distinct small objects for the parallel tests.
const SMALL_COUNT = 250;
// Kept under the free plan's subrequest limit for one request.
const SEED_BATCH = 40;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/":
          return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
        case "/ping":
          return json({ ok: true });
        case "/info":
          return json({
            colo: request.cf?.colo ?? null,
            country: request.cf?.country ?? null,
            httpProtocol: request.cf?.httpProtocol ?? null,
            bucket: env.BUCKET_NAME,
            presign: Boolean(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY),
            publicBase: env.PUBLIC_BASE || null,
            keys: allKeys(),
          });
        case "/seed":
          return await seed(env, Number(url.searchParams.get("batch") ?? 0));
        case "/presign":
          return await presignAll(env, url.searchParams.getAll("key"));
        default:
          if (url.pathname.startsWith("/obj/")) {
            return await read(env, request, url.pathname.slice(5));
          }
          return new Response("not found", { status: 404 });
      }
    } catch (e) {
      return json({ error: String(e?.stack ?? e) }, 500);
    }
  },
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function allKeys() {
  const keys = Object.keys(SIZES).map((name) => `latency/size-${name}.bin`);
  for (let i = 0; i < SMALL_COUNT; i++) keys.push(smallKey(i));
  return keys;
}

function smallKey(i) {
  return `latency/small-${String(i).padStart(3, "0")}.bin`;
}

function sizeOf(key) {
  const named = /size-(\w+)\.bin$/.exec(key);
  return named ? SIZES[named[1]] : SIZES["4k"];
}

// Writes the test objects, SEED_BATCH per request; the page calls each
// batch in turn until `done`.
async function seed(env, batch) {
  const keys = allKeys();
  const slice = keys.slice(batch * SEED_BATCH, (batch + 1) * SEED_BATCH);
  for (const key of slice) {
    const bytes = new Uint8Array(sizeOf(key));
    // getRandomValues fills at most 65536 bytes per call.
    for (let at = 0; at < bytes.length; at += 65536) {
      crypto.getRandomValues(bytes.subarray(at, Math.min(at + 65536, bytes.length)));
    }
    await env.BUCKET.put(key, bytes);
  }
  const done = (batch + 1) * SEED_BATCH >= keys.length;
  return json({ written: slice.length, done });
}

// Reads one object through the binding. Server-Timing gives the time
// spent between this Worker and R2.
async function read(env, request, key) {
  const started = Date.now();
  const object = await env.BUCKET.get(key, { range: request.headers });
  const r2Ms = Date.now() - started;
  if (!object) return new Response("not found", { status: 404 });
  const headers = new Headers({
    "cache-control": "no-store",
    "server-timing": `r2;dur=${r2Ms}`,
    "timing-allow-origin": "*",
  });
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  if (object.range && request.headers.has("range")) {
    const offset = object.range.offset ?? 0;
    const length = object.range.length ?? object.size - offset;
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    return new Response(object.body, { status: 206, headers });
  }
  return new Response(object.body, { headers });
}

async function presignAll(env, keys) {
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    return json({ error: "R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are not set" }, 400);
  }
  const now = new Date();
  const signer = await Signer.create(env, now);
  const urls = {};
  for (const key of keys) urls[key] = await signer.url(key);
  return json({ urls });
}

// AWS Signature V4 query signing for GET, as R2's S3 API accepts it.
class Signer {
  static async create(env, now) {
    const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const date = amzDate.slice(0, 8);
    let key = await hmac(utf8(`AWS4${env.R2_SECRET_ACCESS_KEY}`), date);
    for (const part of ["auto", "s3", "aws4_request"]) key = await hmac(key, part);
    return new Signer(env, amzDate, date, key);
  }

  constructor(env, amzDate, date, signingKey) {
    this.host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    this.bucket = env.BUCKET_NAME;
    this.accessKeyId = env.R2_ACCESS_KEY_ID;
    this.amzDate = amzDate;
    this.scope = `${date}/auto/s3/aws4_request`;
    this.signingKey = signingKey;
  }

  async url(key) {
    const path = `/${this.bucket}/${key.split("/").map(encodeRfc3986).join("/")}`;
    const params = [
      ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
      ["X-Amz-Credential", `${this.accessKeyId}/${this.scope}`],
      ["X-Amz-Date", this.amzDate],
      ["X-Amz-Expires", "3600"],
      ["X-Amz-SignedHeaders", "host"],
    ];
    const query = params
      .map(([name, value]) => `${encodeRfc3986(name)}=${encodeRfc3986(value)}`)
      .sort()
      .join("&");
    const canonical = ["GET", path, query, `host:${this.host}`, "", "host", "UNSIGNED-PAYLOAD"].join("\n");
    const toSign = ["AWS4-HMAC-SHA256", this.amzDate, this.scope, await sha256Hex(canonical)].join("\n");
    const signature = hex(await hmac(this.signingKey, toSign));
    return `https://${this.host}${path}?${query}&X-Amz-Signature=${signature}`;
  }
}

function utf8(text) {
  return new TextEncoder().encode(text);
}

async function hmac(keyBytes, text) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(text)));
}

async function sha256Hex(text) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(text))));
}

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function encodeRfc3986(text) {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
