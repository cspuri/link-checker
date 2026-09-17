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

// ---- Crawl config (kept simple and fast -- no retries, no per-host throttling) ----
const PAGE_CONCURRENCY = 8;
const LINK_CONCURRENCY = 12;
const TIMEOUT_MS = 20000;
const USER_AGENT = "Mozilla/5.0 (compatible; BrokenLinkChecker/1.0)";

// Anything in this list of status codes (or a network-level ERROR) is
// reported as broken. No further categorization -- simple and fast.
const BROKEN_CODES = [400, 401, 403, 404, 405, 410, 500, 502, 503, 504];

// Confirmed from actual helpx.adobe.com page markup.
const CONTENT_SELECTOR = "#helpxNext-article-right-rail";
const TOC_SELECTOR = "#helpxNext-article-left-rail";
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

// Pulls every real article link out of a page's left-rail TOC.
// Category headers (e.g. "Get started") are <span> toggles, not <a> tags,
// so a plain a[href] selector naturally only picks up actual destination
// pages -- no extra filtering needed there. Throws if the page couldn't be
// fetched or has no TOC at all (e.g. a landing/hub page using a different
// template).
async function expandTocForUrl(seedUrl) {
  const res = await axios.get(seedUrl, {
    timeout: TIMEOUT_MS,
    headers: { "User-Agent": USER_AGENT },
    validateStatus: () => true,
  });
  if (res.status >= 400) {
    throw new Error(`page returned ${res.status}`);
  }

  const $ = cheerio.load(res.data);
  let tocScope = $(TOC_SELECTOR);
  if (tocScope.length === 0) tocScope = $(".tocmobile");
  if (tocScope.length === 0) {
    throw new Error("no TOC found on this page (it may not use the article template)");
  }

  const hrefs = [];
  tocScope.find("a[href]").each((_, el) => hrefs.push($(el).attr("href")));
  return [...new Set(hrefs.map((h) => resolveUrl(seedUrl, h)).filter(isCheckableLink))];
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

  const limit = pLimit(LINK_CONCURRENCY);
  let doneCount = 0;
  let brokenCount = 0;

  await Promise.all(
    links.map((l) =>
      limit(async () => {
        const r = await checkLinkStatus(l);
        doneCount++;

        if (r.status === "ERROR" || BROKEN_CODES.includes(r.status)) {
          brokenCount++;
          log(job, `  [${doneCount}/${links.length}] [BROKEN] [${r.status}] ${r.url}${r.error ? " -- " + r.error : ""}`);
          csvStream.write(toCsvRow([pageUrl, r.url, r.status, r.error || ""]) + "\n");
          job.brokenRows.push({ page: pageUrl, link: r.url, status: r.status, error: r.error || "" });
        } else {
          log(job, `  [${doneCount}/${links.length}] [OK] [${r.status}] ${r.url}`);
        }
      })
    )
  );

  if (brokenCount === 0) log(job, `  No broken links on this page.`);

  return { checked: links.length, broken: brokenCount };
}

async function runJob(job) {
  const csvPath = path.join(REPORTS_DIR, `${job.id}.csv`);
  const csvStream = fs.createWriteStream(csvPath, { encoding: "utf-8" });
  csvStream.write(toCsvRow(["source_page", "broken_link", "status", "error"]) + "\n");

  job.status = "running";
  job.csvPath = csvPath;

  let pagesToCheck = job.urls;

  if (job.expandToc) {
    // "Already discovered = never re-expand" -- this is what prevents a
    // loop: every page on a product's TOC lists the SAME TOC, so we only
    // ever expand the original seed URL, never pages found through it.
    const master = new Set(job.urls);

    for (const seedUrl of job.urls) {
      log(job, `\n[TOC expansion] Reading TOC from: ${seedUrl}`);
      let discovered;
      try {
        discovered = await expandTocForUrl(seedUrl);
      } catch (err) {
        log(job, `  [TOC expansion FAILED] ${err.message}`);
        continue;
      }

      let added = 0;
      for (const link of discovered) {
        if (!master.has(link)) {
          master.add(link);
          added++;
        }
      }
      log(job, `  Found ${discovered.length} pages listed in this TOC (${added} new).`);
    }

    pagesToCheck = [...master];
    job.urls = pagesToCheck; // so /api/status reports the real total, not just the seed count
    log(job, `\n[TOC expansion] Total pages to check this run: ${pagesToCheck.length}\n`);
  }

  const pageLimit = pLimit(PAGE_CONCURRENCY);
  await Promise.all(
    pagesToCheck.map((pageUrl) =>
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
  log(job, `\n=== DONE === ${job.donePages}/${pagesToCheck.length} pages, ${job.totalChecked} links checked, ${job.totalBroken} broken found.`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- Simple FIFO queue: only one job actually runs at a time (keeps this
// small internal tool light on resources), but submissions queue up instead
// of getting rejected with an error. ----
let queueRunning = false;

async function processQueue() {
  if (queueRunning) return;
  queueRunning = true;
  while (true) {
    const next = [...jobs.values()]
      .filter((j) => j.status === "queued")
      .sort((a, b) => a.startedAt - b.startedAt)[0];
    if (!next) break;

    const runPromise = runJob(next).catch((err) => {
      next.status = "error";
      log(next, `Fatal error: ${err.message}`);
    });

    // Move on to the next queued person as soon as EITHER the job finishes
    // naturally, OR someone resets it -- rather than always waiting for the
    // job's own network calls to fully settle (which could take a while if
    // something's genuinely stuck). If reset while still in flight, the old
    // job's requests keep running harmlessly in the background and just get
    // ignored once they finish.
    while (next.status === "running" || next.status === "queued") {
      const finishedNaturally = await Promise.race([
        runPromise.then(() => true),
        sleep(500).then(() => false),
      ]);
      if (finishedNaturally) break;
    }
  }
  queueRunning = false;
}

function queuePositionFor(job) {
  if (job.status !== "queued") return 0;
  return [...jobs.values()].filter(
    (j) => j.status === "queued" && j.startedAt <= job.startedAt
  ).length;
}

// ---- Routes ----

app.post("/api/reset", (req, res) => {
  const { jobId } = req.body || {};

  if (!jobId) {
    return res.json({ cleared: 0, message: "No active check found for you to reset." });
  }

  const job = jobs.get(jobId);
  if (!job) {
    return res.json({ cleared: 0, message: "That check no longer exists (maybe it already finished)." });
  }

  if (job.status === "running" || job.status === "queued") {
    job.status = "error";
    log(job, "\n[Reset by the person who started this check]");
    return res.json({ cleared: 1 });
  }

  return res.json({ cleared: 0, message: "That check has already finished -- nothing to reset." });
});

app.post("/api/run", (req, res) => {
  const { urls, expandToc } = req.body || {};
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

  if (expandToc && urlList.length > 1) {
    return res.status(400).json({
      error: "TOC expansion only works with one URL at a time -- remove the extra lines or uncheck the box.",
    });
  }

  const id = crypto.randomBytes(6).toString("hex");
  const job = {
    id,
    status: "queued",
    urls: urlList,
    expandToc: !!expandToc,
    donePages: 0,
    totalChecked: 0,
    totalBroken: 0,
    log: [],
    brokenRows: [],
    csvPath: null,
    startedAt: Date.now(),
  };
  jobs.set(id, job);

  processQueue(); // fire and forget -- kicks off the queue if idle

  res.json({ jobId: id, queuePosition: queuePositionFor(job) });
});

app.get("/api/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({
    id: job.id,
    status: job.status,
    queuePosition: queuePositionFor(job),
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
