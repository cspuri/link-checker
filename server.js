/**
 * Link Checker — local web app
 *
 * Run:
 *   npm install
 *   node server.js
 *
 * Then, on your Mac, open http://localhost:3000
 * Teammates on the same VPN open http://<your-mac-ip>:3000
 * (find your IP with: ipconfig getifaddr en0)
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");
const pLimit = require("p-limit");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// ---- Crawl config ----
const PAGE_CONCURRENCY = 8;
const LINK_CONCURRENCY = 10;
const PER_HOST_CONCURRENCY = 2; // avoid bursts to the same domain tripping bot-protection
const TIMEOUT_MS = 20000;
const RETRY_DELAYS_MS = [800, 2500]; // retry transient failures before giving up
const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// Confirmed-broken: the server explicitly says the resource is gone/invalid.
// These are reliable, no ambiguity.
const BROKEN_CODES = [400, 404, 405, 410];

// Needs-review: could be a real problem OR bot-protection blocking an
// automated request (very common for Cloudflare/Akamai-protected sites,
// gov/edu portals, Zendesk help centers, stock.adobe.com, etc). We flag
// these separately instead of calling them definitively broken.
const REVIEW_CODES = [401, 403, 429, 500, 502, 503];

// Confirmed from actual helpx.adobe.com page markup.
const CONTENT_SELECTOR = "#helpxNext-article-right-rail";
const EXCLUDE_SELECTORS = [
  "#helpxNext-article-left-rail",
  ".tocmobile",
  ".sideNavigation",
  ".globalnavheader",
  ".globalnavfooter",
  ".flex_top_nav",
];

// ---- In-memory job store (single-process, fine for a small internal tool) ----
const jobs = new Map(); // jobId -> job state
const REPORTS_DIR = path.join(__dirname, "reports");
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR);

function resolveUrl(base, href) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function isCheckableLink(url) {
  if (!url) return false;
  if (/^(mailto:|tel:|javascript:)/i.test(url)) return false;
  if (/^#/.test(url)) return false;
  return /^https?:\/\//i.test(url);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function checkLinkStatusOnce(url) {
  try {
    let res = await axios.head(url, {
      timeout: TIMEOUT_MS,
      headers: REQUEST_HEADERS,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    if (res.status === 405 || res.status === 501 || res.status >= 400) {
      res = await axios.get(url, {
        timeout: TIMEOUT_MS,
        headers: REQUEST_HEADERS,
        maxRedirects: 5,
        validateStatus: () => true,
      });
    }
    return { url, status: res.status, error: null };
  } catch (err) {
    return { url, status: "ERROR", error: err.code || err.message };
  }
}

async function checkLinkStatus(url) {
  let result = await checkLinkStatusOnce(url);

  // Retry transient-looking failures (network errors, or status codes that
  // are often bot-protection rather than a real broken link) before giving up.
  const isTransient = (r) => r.status === "ERROR" || REVIEW_CODES.includes(r.status);

  for (let i = 0; i < RETRY_DELAYS_MS.length && isTransient(result); i++) {
    await sleep(RETRY_DELAYS_MS[i]);
    result = await checkLinkStatusOnce(url);
  }

  return result;
}

function toCsvRow(fields) {
  return fields
    .map((f) => {
      const s = String(f ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}

function log(job, line) {
  job.log.push(line);
  if (job.log.length > 2000) job.log.shift(); // keep memory bounded
}

// Per-host concurrency limiter: keeps us from firing a burst of requests at
// the same domain at once, which is one of the things that trips bot-protection
// (WAFs like Cloudflare/Akamai often treat bursts from one IP as an attack).
const hostLimiters = new Map();
function limiterForHost(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    host = "unknown";
  }
  if (!hostLimiters.has(host)) {
    hostLimiters.set(host, pLimit(PER_HOST_CONCURRENCY));
  }
  return hostLimiters.get(host);
}

async function processPage(job, pageUrl, csvStream) {
  log(job, `--- Page: ${pageUrl}`);

  let pageRes;
  try {
    pageRes = await axios.get(pageUrl, {
      timeout: TIMEOUT_MS,
      headers: REQUEST_HEADERS,
      validateStatus: () => true,
    });
  } catch (err) {
    log(job, `  [FAILED TO FETCH PAGE] ${err.message}`);
    csvStream.write(toCsvRow([pageUrl, "", "FETCH_FAILED", err.message, "NEEDS_REVIEW"]) + "\n");
    return { checked: 0, broken: 0, review: 0 };
  }

  if (pageRes.status >= 400) {
    log(job, `  [PAGE RETURNED ${pageRes.status}] skipping link extraction`);
    csvStream.write(toCsvRow([pageUrl, "", pageRes.status, "source page itself failed", "NEEDS_REVIEW"]) + "\n");
    return { checked: 0, broken: 0, review: 0 };
  }

  const $ = cheerio.load(pageRes.data);
  for (const sel of EXCLUDE_SELECTORS) $(sel).remove();

  // Try the article-page content container first. Some helpx pages (like
  // product landing/hub pages) use a different template and won't have
  // this container at all -- in that case, fall back to the whole body
  // (with TOC/nav already stripped out above).
  let scope = CONTENT_SELECTOR ? $(CONTENT_SELECTOR) : $("body");
  let usedFallback = false;
  if (CONTENT_SELECTOR && scope.length === 0) {
    scope = $("body");
    usedFallback = true;
  }

  const rawHrefs = [];
  scope.find("a[href]").each((_, el) => rawHrefs.push($(el).attr("href")));
  const links = [...new Set(rawHrefs.map((h) => resolveUrl(pageUrl, h)).filter(isCheckableLink))];

  log(job, `  Found ${links.length} links${usedFallback ? " (used body fallback -- content container not found on this page template)" : ""}. Checking...`);

  const overallLimit = pLimit(LINK_CONCURRENCY);
  const results = await Promise.all(
    links.map((l) => overallLimit(() => limiterForHost(l)(() => checkLinkStatus(l))))
  );

  let brokenCount = 0;
  let reviewCount = 0;
  for (const r of results) {
    const isConfirmedBroken = BROKEN_CODES.includes(r.status);
    const isNeedsReview = r.status === "ERROR" || REVIEW_CODES.includes(r.status);

    if (isConfirmedBroken) {
      brokenCount++;
      log(job, `  [BROKEN] [${r.status}] ${r.url}${r.error ? " -- " + r.error : ""}`);
      csvStream.write(toCsvRow([pageUrl, r.url, r.status, r.error || "", "BROKEN"]) + "\n");
      job.brokenRows.push({ page: pageUrl, link: r.url, status: r.status, error: r.error || "", confidence: "BROKEN" });
    } else if (isNeedsReview) {
      reviewCount++;
      log(job, `  [NEEDS REVIEW] [${r.status}] ${r.url}${r.error ? " -- " + r.error : ""} (may be bot-protection, not necessarily broken)`);
      csvStream.write(toCsvRow([pageUrl, r.url, r.status, r.error || "", "NEEDS_REVIEW"]) + "\n");
      job.brokenRows.push({ page: pageUrl, link: r.url, status: r.status, error: r.error || "", confidence: "NEEDS_REVIEW" });
    }
  }

  if (brokenCount === 0 && reviewCount === 0) log(job, `  No issues found on this page.`);

  return { checked: links.length, broken: brokenCount, review: reviewCount };
}

async function runJob(job) {
  const csvPath = path.join(REPORTS_DIR, `${job.id}.csv`);
  const csvStream = fs.createWriteStream(csvPath, { encoding: "utf-8" });
  csvStream.write(toCsvRow(["source_page", "broken_link", "status", "error", "confidence"]) + "\n");

  job.status = "running";
  job.csvPath = csvPath;

  const pageLimit = pLimit(PAGE_CONCURRENCY);
  await Promise.all(
    job.urls.map((pageUrl) =>
      pageLimit(async () => {
        const { checked, broken, review } = await processPage(job, pageUrl, csvStream);
        job.totalChecked += checked;
        job.totalBroken += broken;
        job.totalReview += review;
        job.donePages++;
      })
    )
  );

  csvStream.end();
  job.status = "done";
  log(
    job,
    `\n=== DONE === ${job.donePages}/${job.urls.length} pages, ${job.totalChecked} links checked, ` +
      `${job.totalBroken} confirmed broken, ${job.totalReview} need manual review (likely bot-protection, not necessarily broken).`
  );
}

// ---- Routes ----

app.post("/api/run", (req, res) => {
  const { urls } = req.body || {};
  if (!urls || typeof urls !== "string") {
    return res.status(400).json({ error: "Provide 'urls' as a newline-separated string." });
  }

  const urlList = urls
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  if (urlList.length === 0) {
    return res.status(400).json({ error: "No valid URLs found." });
  }

  // Only one job running at a time on this simple internal tool.
  const alreadyRunning = [...jobs.values()].some((j) => j.status === "running");
  if (alreadyRunning) {
    return res.status(409).json({ error: "A check is already running. Wait for it to finish." });
  }

  const id = crypto.randomBytes(6).toString("hex");
  const job = {
    id,
    status: "queued",
    urls: urlList,
    donePages: 0,
    totalChecked: 0,
    totalBroken: 0,
    totalReview: 0,
    log: [],
    brokenRows: [],
    csvPath: null,
    startedAt: Date.now(),
  };
  jobs.set(id, job);

  runJob(job).catch((err) => {
    job.status = "error";
    log(job, `Fatal error: ${err.message}`);
  });

  res.json({ jobId: id });
});

app.get("/api/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({
    id: job.id,
    status: job.status,
    totalPages: job.urls.length,
    donePages: job.donePages,
    totalChecked: job.totalChecked,
    totalBroken: job.totalBroken,
    totalReview: job.totalReview,
    log: job.log,
    brokenRows: job.brokenRows,
  });
});

app.get("/api/download/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.csvPath || !fs.existsSync(job.csvPath)) {
    return res.status(404).send("Report not found or job not finished yet.");
  }
  res.download(job.csvPath, `broken-links-${job.id}.csv`);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Link Checker running.`);
  console.log(`  Local:    http://localhost:${PORT}`);
  console.log(`  Network:  http://<your-mac-ip>:${PORT}  (find your IP with: ipconfig getifaddr en0)`);
});

// Catch-all: if any route is hit that doesn't exist, respond with JSON
// (not Express's default HTML page) so the frontend never chokes on HTML.
app.use((req, res) => {
  res.status(404).json({ error: `No such endpoint: ${req.method} ${req.path}` });
});

// Global error handler: guarantees JSON responses even if a route throws.
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: err.message || "Internal server error" });
});
