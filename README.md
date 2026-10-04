# R2 latency test

A Worker that serves a page to time GETs from a browser to R2. It measures the round trip, many GETs at once, object size, range reads, and a chart redraw (one small GET, then four 64 KB range reads at once). It tests up to three paths:

- **worker**: through this Worker's R2 binding. Needs only the bucket.
- **direct**: presigned URLs straight to R2's S3 endpoint. Needs an R2 API token and a CORS rule on the bucket.
- **public**: a custom domain or `r2.dev` URL for the bucket. Optional.

## Setup

1. **Create the bucket** `latency-test` in the Cloudflare dashboard (R2 → Create bucket). To use another name, change `bucket_name` and `BUCKET_NAME` in `wrangler.jsonc`.
2. **Check the Worker name.** `name` in `wrangler.jsonc` must match the Worker's name in the dashboard, or the Git build fails.
3. **Create an R2 API token** (R2 → Manage API tokens → Create API token) with "Object Read only" on `latency-test`. Keep the Access Key ID and Secret Access Key.
4. **Add three secrets** to the Worker (Workers → the Worker → Settings → Variables and Secrets, type Secret):
   - `R2_ACCOUNT_ID`: your account ID (on the R2 overview page).
   - `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`: from step 3.
5. **Add a CORS rule** to the bucket (R2 → `latency-test` → Settings → CORS policy), with your Worker's address:

   ```json
   [
     {
       "AllowedOrigins": ["https://cloudflare-test.<your-subdomain>.workers.dev"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["range"],
       "ExposeHeaders": ["content-length", "content-range", "etag", "cf-cache-status", "age"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

6. **Optional public path:** connect a custom domain to the bucket, or turn on its `r2.dev` URL, and set `PUBLIC_BASE` in `wrangler.jsonc` to that address with no trailing slash.
7. **Deploy** by pushing to the production branch; the Git link builds it.

## Use

1. Open the Worker's address and press **Seed test objects** once. It writes 254 objects (8 MB, 1 MB, 64 KB, and 251 of 4 KB).
2. Press **Run**. A full run takes about a minute and makes about 2,000 GETs.
3. Press **Copy JSON** and keep the result.
4. Repeat on each device and network that matters: laptop on home Wi-Fi, office network, phone on mobile data.

Times depend on where you are and where the bucket is. The page shows the Cloudflare location that served it. The "ping" row is the round trip to Cloudflare alone, with no R2, and the "Worker to R2 only" row is the time between the Worker and R2.

## Local development

```sh
npm install
npx wrangler dev
```

`wrangler dev` uses a local R2 store. For the direct path locally, put the three secrets in `.dev.vars`; the URLs then point at the real R2.
