```
▗▖  ▗▖▗▄▄▖ ▗▖  ▗▖    ▗▄▄▖ ▗▄▄▄▖▗▄▄▖ ▗▄▄▄▖     ▗▄▄▖▗▖ ▗▖ ▗▄▖ ▗▄▄▖ ▗▄▄▄  
▐▛▚▖▐▌▐▌ ▐▌▐▛▚▞▜▌    ▐▌ ▐▌  █  ▐▌ ▐▌▐▌       ▐▌   ▐▌ ▐▌▐▌ ▐▌▐▌ ▐▌▐▌  █ 
▐▌ ▝▜▌▐▛▀▘ ▐▌  ▐▌    ▐▛▀▚▖  █  ▐▛▀▘ ▐▛▀▀▘    ▐▌▝▜▌▐▌ ▐▌▐▛▀▜▌▐▛▀▚▖▐▌  █ 
▐▌  ▐▌▐▌   ▐▌  ▐▌    ▐▌ ▐▌▗▄█▄▖▐▌   ▐▙▄▄▖    ▝▚▄▞▘▝▚▄▞▘▐▌ ▐▌▐▌ ▐▌▐▙▄▄▀ 
```

> A local npm registry proxy that blocks packages published less than **24 hours ago**.

Many supply-chain attacks exploit the brief window right after a malicious package is pushed to npm — before security scanners catch it. **npm-ripe-guard** enforces a 24-hour quarantine on all new versions before they can be installed.

---

## How it works

```
npm install foo  →  npm-ripe-guard  →  registry.npmjs.org
                          │
                          ├─ fetch metadata (cached 5 min)
                          ├─ resolve dist-tag  →  exact version
                          ├─ check publish timestamp
                          │
                          ├─ published < 24 h ago  →  403 Forbidden
                          └─ published ≥ 24 h ago  →  stream response
```

- Scoped packages (`@org/pkg`) and dist-tags (`latest`, `next`, …) are handled correctly
- If no timestamp is available the package is allowed through
- Non-GET requests (publish, unpublish) are forwarded without inspection

---

## Setup

**Requires Node.js ≥ 18**

```bash
git clone <repo>
cd npm-ripe-guard
npm install
npm start
```

Point npm at the proxy — pick the scope that fits:

```bash
# one-off install
npm install --registry http://localhost:4873 <package>

# current user (persists across sessions)
npm config set registry http://localhost:4873

# per project — add to .npmrc
echo "registry=http://localhost:4873" >> .npmrc
```

To restore the default registry:

```bash
npm config delete registry
```

---

## What a blocked install looks like

```
$ npm install some-brand-new-package

npm error code E403
npm error {
npm error   "error": "ERR_PACKAGE_TOO_NEW",
npm error   "message": "some-brand-new-package@1.0.0 was published 37 minute(s) ago.
npm error              Packages must be at least 24 hours old.
npm error              Installation will be available at 2024-01-16T09:37:00.000Z.",
npm error   "package": "some-brand-new-package",
npm error   "version": "1.0.0",
npm error   "publishedAt": "2024-01-15T09:37:00.000Z",
npm error   "availableAt": "2024-01-16T09:37:00.000Z"
npm error }
```

---

## Health check

```bash
curl http://localhost:4873/health
```

```json
{ "status": "ok", "uptime": 42, "cachedPackages": 3 }
```

---

## Configuration

| Variable    | Default  | Description                                              |
|-------------|----------|----------------------------------------------------------|
| `PORT`      | `4873`   | Port to listen on                                        |
| `LOG_LEVEL` | `info`   | Log verbosity (`trace` `debug` `info` `warn` `error`)    |

---

## Running as a service (Linux / systemd)

```bash
sudo cp npm-ripe-guard.service /etc/systemd/system/
# edit WorkingDirectory and ExecStart paths inside the file first
sudo systemctl daemon-reload
sudo systemctl enable --now npm-ripe-guard
```

`npm-ripe-guard.service`:

```ini
[Unit]
Description=npm-ripe-guard registry proxy
After=network.target

[Service]
Type=simple
User=nobody
WorkingDirectory=/opt/npm-ripe-guard
ExecStart=/usr/bin/node /opt/npm-ripe-guard/server.js
Restart=on-failure
Environment=PORT=4873

[Install]
WantedBy=multi-user.target
```

To enforce the proxy for all users on the machine, add to `/etc/npmrc`:

```
registry=http://localhost:4873
```
