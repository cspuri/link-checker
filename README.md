# Link Checker — Web App

Two ways to run this:
- **Option A: Deploy to Render (recommended)** — permanent URL, no VPN, no Mac needed. See below.
- **Option B: Run locally on your Mac** — see "Local setup" further down.

---

## Option A: Deploy to Render (free tier)

This gives your team a permanent link like `https://link-checker-yourname.onrender.com`
that works from anywhere, with nothing running on your machine.

### 1. Put this code in a GitHub repo

If you don't already have one:

```bash
cd link-checker-server
git init
git add .
git commit -m "Link checker"
```

Then create a new empty repo on [github.com/new](https://github.com/new), and push:

```bash
git remote add origin https://github.com/<your-username>/link-checker.git
git branch -M main
git push -u origin main
```

(No GitHub account? You can also just drag-and-drop the folder as a zip into
Render's dashboard if it supports it, but connecting a repo is the standard
path and lets you redeploy easily later by just pushing changes.)

### 2. Create the service on Render

1. Go to [render.com](https://render.com) and sign up / log in (GitHub login is easiest).
2. Click **New +** → **Web Service**.
3. Connect your GitHub account and select the `link-checker` repo.
4. Render should auto-detect the settings from `render.yaml`, but if asked manually, set:
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Click **Create Web Service**.

Render will build and deploy — takes a couple of minutes the first time.
You'll get a URL like `https://link-checker-xxxx.onrender.com`.

### 3. Share that URL with your team

That's it — anyone with the link can open it in a browser, paste URLs, and
run checks. No VPN, no installs, no Mac required.

### Notes on the free tier

- **Spins down after inactivity.** If nobody uses it for ~15 minutes, Render
  puts it to sleep. The next person to open the link will wait ~30–50
  seconds for it to wake up — normal for free tier, not a bug.
- **One check runs at a time**, same as before — if two people click "Run
  check" simultaneously, the second gets an in-progress message.
- **Reports are temporary.** CSVs live on the server's disk only until the
  next restart/sleep cycle, so tell people to download their CSV right after
  a run finishes rather than coming back for it later.

---

## Option B: Local setup (run on your Mac)

## 1. Set up (one-time, on your Mac)

```bash
cd link-checker-server
npm install
```

## 2. Run it

```bash
node server.js
```

You'll see:

```
Link Checker running.
  Local:    http://localhost:3000
  Network:  http://<your-mac-ip>:3000  (find your IP with: ipconfig getifaddr en0)
```

Keep this terminal window open — the server needs to keep running for others
to use it. If you close the terminal or your Mac sleeps, the app stops.

## 3. Find your Mac's IP address (for teammates to use)

```bash
ipconfig getifaddr en0
```

(If you're on Wi-Fi this is usually `en0`; on Ethernet it may be `en1` — try
both if one doesn't return an address.)

This gives you something like `10.8.0.23` (VPN IPs often look like this, or
similar to your regular LAN IP if the VPN bridges the network).

## 4. Share the link

Once your team is connected to the same VPN, send them:

```
http://<your-mac-ip>:3000
```

Example: `http://10.8.0.23:3000`

They open that in any browser, paste in the list of helpx page URLs, hit
**Run check**, and watch the live log and stats. When it finishes, a
**Download CSV** button appears with the broken-links report.

## Notes

- **One check at a time.** This is a simple internal tool — if someone
  starts a check while another is running, they'll see a message asking
  them to wait.
- **Your Mac needs to stay awake and connected** while a check is running
  and while others might want to use it. If your Mac sleeps, the server
  stops responding until you wake it.
- **Firewall:** macOS may prompt you the first time to allow incoming
  network connections for Node — click **Allow**.
- **Security:** anyone who can reach that IP:port (i.e., anyone on your
  VPN) can use this tool. That's expected for a trusted internal team, but
  don't expose this port outside the VPN/firewall.
- Reports are saved under `reports/<job-id>.csv` in this folder if you want
  to grab an older one directly from disk.
