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
const TIMEOUT_MS = 15000;
const USER_AGENT = "Mozilla/5.0 (compatible; BrokenLinkChecker/1.0)";
const BROKEN_CODES = [400, 401, 403, 404, 405, 410, 500, 502, 503, 504];

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

async function checkLinkStatus(url) {
  try {
    let res = await axios.head(url, {
      timeout: TIMEOUT_MS,
      headers: { "User-Agent": USER_AGENT },
      maxRedirects: 5,
      validateStatus: () => true,
    });
    if (res.status === 405 || res.status === 501 || res.status >= 400) {
      res = await axios.get(url, {
        timeout: TIMEOUT_MS,
        headers: { "User-Agent": USER_AGENT },
        maxRedirects: 5,
        validateStatus: () => true,
      });
    }
    return { url, status: res.status, error: null };
  } catch (err) {
    return { url, status: "ERROR", error: err.code || err.message };
  }
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

async function processPage(job, pageUrl, csvStream) {
  log(job, `--- Page: ${pageUrl}`);

  let pageRes;
  try {
    pageRes = await axios.get(pageUrl, {
      timeout: TIMEOUT_MS,
      headers: { "User-Agent": USER_AGENT },
      validateStatus: () => true,
    });
  } catch (err) {
    log(job, `  [FAILED TO FETCH PAGE] ${err.message}`);
    csvStream.write(toCsvRow([pageUrl, "", "FETCH_FAILED", err.message]) + "\n");
    return { checked: 0, broken: 0 };
  }

  if (pageRes.status >= 400) {
    log(job, `  [PAGE RETURNED ${pageRes.status}] skipping link extraction`);
    csvStream.write(toCsvRow([pageUrl, "", pageRes.status, "source page itself failed"]) + "\n");
    return { checked: 0, broken: 0 };
  }

  const $ = cheerio.load(pageRes.data);
  for (const sel of EXCLUDE_SELECTORS) $(sel).remove();
  const scope = CONTENT_SELECTOR ? $(CONTENT_SELECTOR) : $("body");

  const rawHrefs = [];
  scope.find("a[href]").each((_, el) => rawHrefs.push($(el).attr("href")));
  const links = [...new Set(rawHrefs.map((h) => resolveUrl(pageUrl, h)).filter(isCheckableLink))];

  log(job, `  Found ${links.length} links. Checking...`);

  const limit = pLimit(LINK_CONCURRENCY);
  const results = await Promise.all(links.map((l) => limit(() => checkLinkStatus(l))));

  let brokenCount = 0;
  for (const r of results) {
    const isBroken = r.status === "ERROR" || BROKEN_CODES.includes(r.status);
    if (isBroken) {
      brokenCount++;
      log(job, `  [BROKEN] [${r.status}] ${r.url}${r.error ? " -- " + r.error : ""}`);
      csvStream.write(toCsvRow([pageUrl, r.url, r.status, r.error || ""]) + "\n");
      job.brokenRows.push({ page: pageUrl, link: r.url, status: r.status, error: r.error || "" });
    }
  }

  if (brokenCount === 0) log(job, `  No broken links on this page.`);

  return { checked: links.length, broken: brokenCount };
}

async function runJob(job) {
  const csvPath = path.join(REPORTS_DIR, `${job.id}.csv`);
  const csvStream = fs.createWriteStream(csvPath, { encoding: "utf-8" });
  csvStream.write(toCsvRow(["source_page", "broken_link", "status", "error"]) + "\n");

  job.status = "running";
  job.csvPath = csvPath;

  const pageLimit = pLimit(PAGE_CONCURRENCY);
  await Promise.all(
    job.urls.map((pageUrl) =>
      pageLimit(async () => {
        const { checked, broken } = await processPage(job, pageUrl, csvStream);
        job.totalChecked += checked;
        job.totalBroken += broken;
        job.donePages++;
      })
    )
  );

  csvStream.end();
  job.status = "done";
  log(job, `\n=== DONE === ${job.donePages}/${job.urls.length} pages, ${job.totalChecked} links checked, ${job.totalBroken} broken found.`);
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
