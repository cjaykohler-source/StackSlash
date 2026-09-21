# StackSlash — access map

Written 2026-09-21. Every component, who owns it, and what a new operator
needs to get in. **No secret values are in this file or anywhere else in
git.** Credential values live in `~/StackSlash/.env` on the worker host, in
Netlify's site settings, in the macOS keychain, or in each provider's own
dashboard.

Companion docs: `docs/HANDOFF.md` (how it all runs), `README.md` (strategy
and open decisions).

---

## 1. Accounts to be added to

| Component | What it is | How to grant access |
|---|---|---|
| **GitHub** `cjaykohler-source/StackSlash` | The repo; all deploys come from `main` | Add as collaborator (Settings → Collaborators). Needs push rights to merge PRs |
| **Supabase** project `wnzxvdfskmivbyqadtll`, org StackSlash | Production database + Auth | Invite to the *organization* (Supabase dashboard → Organization → Team). Owner/Developer role is needed to read keys and run migrations |
| **Netlify** site `stackslash` | Hosting + scheduled functions | Invite to the team (Netlify → Team → Members). Needed to see deploys, function logs and env vars |
| **Alpaca** | Market data (daily SIP bars, IEX intraday, asset records) | Account is personal to the owner. A new operator needs their own API key pair, or the owner issues keys from Alpaca dashboard → API keys |
| **FMP** (Financial Modeling Prep) | Earnings calendar, company profiles | Free-tier key from the FMP dashboard. Personal to the account holder |
| **Discord** server (HeatBot) | Alerts, digests, integrity warnings | Server invite + the webhook URL. A webhook can be regenerated in Channel → Integrations → Webhooks |
| **IBKR** | Borrow availability, delayed quotes | Personal brokerage account. Access means running IB Gateway on the host with that login; there is no shareable key |
| **Robinhood** (MCP connector) | Float, listing status, L2, SEC facts | Personal brokerage account, connected per Claude session in connector settings. Cannot be shared or used by host jobs |
| **The host** `stackslash-worker-host` | Where every job actually runs | macOS login for user `ckohler`. Without this, nothing can be operated — see §4 |

---

## 2. Credentials and where they live

`~/StackSlash/.env` on the host (git-ignored, mode 600 recommended). Names
only:

| Variable | Used by | Re-issue at |
|---|---|---|
| `SUPABASE_URL` | All server-side jobs | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | All server-side writes; **bypasses RLS — treat as root** | Supabase → Project Settings → API (rotate there) |
| `VITE_SUPABASE_URL` | The site (browser bundle) | same |
| `VITE_SUPABASE_ANON_KEY` | The site; safe to ship to browsers, RLS-limited | same |
| `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY` | Bars, snapshots, asset lookups | Alpaca dashboard → API keys |
| `ALPACA_BASE_URL` | Data host selection | n/a (config) |
| `FMP_API_KEY` | `fundamentals-sync` | FMP dashboard |
| `SEC_USER_AGENT` | EDGAR requests; must carry a real contact email (SEC fair-access policy) | n/a (config) |
| `DISCORD_WEBHOOK_URL` | All alerting | Discord channel → Integrations → Webhooks |

**Not in `.env`:**

- **Database password** — stored in the macOS keychain by
  `supabase link --project-ref wnzxvdfskmivbyqadtll`, used by the nightly
  backup. Reset at Supabase → Project Settings → Database. Nothing else
  uses it: the app authenticates with the anon and service-role keys.
- **Netlify environment variables** — the same names as above, set in
  Netlify → Site configuration → Environment variables. Netlify functions
  read these, not the host `.env`. **Both copies must be updated when a key
  rotates.**
- **IBKR login** — entered into IB Gateway by hand; IB forces a re-login
  roughly every 24 h.
- **GitHub auth on the host** — the `gh` CLI is already authenticated as
  `cjaykohler-source`.

---

## 3. What each key can do (blast radius)

- `SUPABASE_SERVICE_ROLE_KEY` reads and writes every table, ignoring RLS.
  Leaking it means losing the database. It is the one credential worth
  rotating immediately if a laptop or log is ever exposed.
- `VITE_SUPABASE_ANON_KEY` ships inside the browser bundle by design.
  Exposure is expected; RLS plus sign-in is what protects the data.
- Alpaca keys are market-data only on this plan, but they are also valid
  against the paper-trading endpoint used for asset lookups. Rotate if
  exposed.
- The Discord webhook lets anyone post into the alert channel.
- The IBKR connection is Read-Only API on a **live** account. Read-only is
  a Gateway setting (Configure → Settings → API → Read-Only API); if it is
  ever unticked, that connection could place orders.

---

## 4. Getting operational control

Everything except the site and the database runs on the host, so host
access is the real handover:

1. **macOS login** for `ckohler` on stackslash-worker-host (and the FileVault
   password if the machine is ever rebooted).
2. Confirm the jobs are loaded: `launchctl list | grep stackslash` — expect
   ~17 labels.
3. Confirm the repo and CLIs: `~/StackSlash`, `gh auth status`,
   `supabase projects list`, `research/.venv/bin/python -V` (3.9).
4. IB Gateway must be started and logged in by hand for the borrow job.
5. Logs live in `~/Library/Logs/stackslash-<job>/`; backups in
   `~/StackSlashBackups/`; the research warehouse in `research/data/`.

Remote access is **not** currently set up (no SSH, no Screen Sharing). If
the project is handed to someone not sitting at this machine, that has to
be arranged first, or the jobs moved to a server.

---

## 5. If handing over permanently

1. Add the new owner to GitHub, Supabase, Netlify and Discord (§1).
2. Have them issue **their own** Alpaca and FMP keys rather than copying
   the current ones; update `.env` on the host *and* Netlify's env vars.
3. Rotate `SUPABASE_SERVICE_ROLE_KEY` and reset the database password once
   the previous owner steps away; update both copies.
4. Regenerate the Discord webhook.
5. Transfer or re-create the IBKR and Robinhood connections — both are
   personal accounts and cannot be transferred as credentials.
6. Hand over the host itself (or migrate the launchd jobs to the new
   operator's machine; the plists are in `scripts/launchd/` and assume the
   path `/Users/ckohler/StackSlash`, which would need editing).
7. Confirm the first nightly backup after the handover actually lands in
   `~/StackSlashBackups/`.
