# Running the tracker 24/7 on a server

For a cloud box (Oracle Cloud free tier, any VPS) or a spare Linux machine
that hosts the leaderboard around the clock. Two systemd units keep it
running **and current**:

| Unit | What it does |
|---|---|
| `h3-tracker.service` | Runs `npm run watch`; restarts on crash and on boot. |
| `h3-tracker-update.timer` | Every 5 minutes: fetch `origin/main`; if there are new commits, fast-forward, `npm ci` when `package.json`/lockfile changed, and restart the tracker. No change → no restart, no noise. |

So pushing to `main` on GitHub is deploying: the server picks the commit up
within ~5 minutes on its own.

## Install

On the server, from your checkout (as the user who owns it):

```sh
cd ~/MCC-Halo-3-Custom-Games-Tracker
sudo deploy/install.sh
```

The installer detects your user, the checkout path, and your node install
(nvm included), writes the units to `/etc/systemd/system`, and starts both.
Re-running it is safe — it just rewrites the units.

Requirements: Linux with systemd, git, Node 20+ for the invoking user, and a
checkout of this repo on the `main` branch. Configure `.env` before (or
after) installing — the updater never touches `.env`, `data/`, or
`aliases.json`, so your config and database survive every update.

## Day to day

```sh
systemctl status h3-tracker              # is the tracker up?
journalctl -u h3-tracker -f              # live tracker logs
journalctl -u h3-tracker-update          # update history (pulls, restarts)
sudo systemctl start h3-tracker-update   # force an update check right now
```

## How updates stay safe

- The updater only fast-forwards (`git merge --ff-only`). If the server
  checkout has local commits, or isn't on `main`, it refuses and logs an
  error instead of merging or discarding anything — fix that by hand once,
  and updates resume.
- `npm ci` runs only when `package.json` or `package-lock.json` actually
  changed in the pull.
- A lock file prevents overlapping runs if an update outlasts the 5-minute
  interval.

## Uninstall

```sh
sudo systemctl disable --now h3-tracker.service h3-tracker-update.timer
sudo rm /etc/systemd/system/h3-tracker.service \
        /etc/systemd/system/h3-tracker-update.service \
        /etc/systemd/system/h3-tracker-update.timer
sudo systemctl daemon-reload
```
