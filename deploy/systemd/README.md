# solrac systemd units

Three units, intended to live in `/etc/systemd/system/` on the host:

- `solrac.service` — main long-running Bun process; `Type=simple`, `Restart=on-failure`, `TimeoutStopSec=90` (lifecycle.ts caps drain at 60s).
- `solrac-bounce.service` — one-shot `systemctl restart solrac.service`. Mitigates Bun long-uptime memory drift (OQ#2).
- `solrac-bounce.timer` — weekly trigger (`Sun 04:00` + `RandomizedDelaySec=300`, `Persistent=true`).

## Assumptions baked into `solrac.service`

| Field | Value | Override how |
|-------|-------|--------------|
| `User=` / `Group=` | `solrac` | edit unit, then `daemon-reload` |
| `WorkingDirectory=` | `/opt/solrac` | edit unit |
| `EnvironmentFile=` | `/etc/solrac/solrac.env` | edit unit |
| `ExecStart=` | `/usr/local/bin/bun run src/main.ts` | edit unit |
| `ReadWritePaths=` | `/opt/solrac/data` | must include `DATA_DIR` |

## Install

```sh
sudo install -d -o solrac -g solrac /opt/solrac
# clone the repo into /opt/solrac, then `npm install`
sudo -u solrac git clone https://github.com/cjus/solrac.git /opt/solrac
sudo -u solrac --preserve-env=PATH bash -c 'cd /opt/solrac && npm install'
sudo install -m 600 -o solrac -g solrac /opt/solrac/.env /etc/solrac/solrac.env
sudo cp /opt/solrac/deploy/systemd/*.service /etc/systemd/system/
sudo cp /opt/solrac/deploy/systemd/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now solrac.service
sudo systemctl enable --now solrac-bounce.timer
```

## Verify

```sh
systemctl status solrac.service
systemctl list-timers solrac-bounce.timer
journalctl -u solrac.service -f
```

## Graceful shutdown contract

`kill -15 $(systemctl show -p MainPID --value solrac.service)` (or `systemctl stop solrac.service`):

1. SIGTERM hits the Bun process.
2. `lifecycle.ts::installShutdown` runs:
   - aborts the Telegram poll loop,
   - stops `Bun.serve`,
   - `tracker.drain()` waits up to 60s for in-flight turns,
   - `PRAGMA wal_checkpoint(TRUNCATE)`,
   - `db.close()`,
   - removes `data/solrac.pid`,
   - `process.exit(0)`.
3. `Restart=on-failure` does **not** restart on exit 0; use `systemctl restart` to bounce.

If drain exceeds 60s, the process exits 1 (treated as failure → systemd restarts).
If drain exceeds 90s, systemd issues SIGKILL; the next boot's stale-PID detection (`poll.ts::acquirePidFile`) cleans up the orphaned `solrac.pid`.
