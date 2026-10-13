# Banking assistant

Standalone assistant service and chat widget for the bank's portal. Spec and tickets live in `bpay-bicec/.scratch/banking-assistant/` (`spec.md`, `map.md`, `issues/`). Story-by-story test coverage: [docs/core-coverage.md](docs/core-coverage.md) (written before the changes listed under "What changed since the first demo", so read it with that section).

## What it does

- **How-to help (EN/FR).** Steps from hand-written guides, quoting the portal's real button names. For any wording of a task ("I want to send money", "pay my electricity bill", "buy airtime") it shows a **"Click here to …" card first** (opens the right portal page) and the **guide's steps below it**. It never fills a form and never executes anything: asking it to confirm, approve or "do it for me" is refused.
- **Reads the customer's own data.** Balance (behind the portal's PIN flag, or the widget's own PIN box), last transactions, a transfer's status, fees and limits, and "explain why my transfer failed". The last transactions are drawn as a table in the portal History layout (Date, Id, From, To, Member, Nature, Type, Amount, Status) with full numbers, **on the customer's own screen only**. The model and the audit log only ever see masked values.
- **Safety.** PIN/OTP/token shield, scam-cue warnings, refusal categories with fixed next-step cards, output filter, rate limits, append-only masked audit log.
- **Human help.** "Talk to a human agent" chip, a drafted case message the customer edits and confirms (chat, email or both), handoff with an in-house agent console, timers, transfer, resolve and cancel.

## Run

```sh
npm install
npm test               # whole automated suite (service API, widget and console in jsdom): 513 pass, 0 fail
npm run check:guides   # fails if a guide exists in one language only
npm start              # service on http://localhost:3000, demo host page on /, agent console on /console
```

```sh
export GROQ_API_KEY=...                         # read from the environment only
npm run eval -- --model qwen/qwen3.8-27b         # the whole EN/FR eval set through the real service (not part of npm test or CI)
npm run eval -- --model qwen/qwen3.8-27b --limit 2   # at most 2 new items this run (cheap check)
```

Gemini (Google's OpenAI-compatible endpoint): `export GEMINI_API_KEY=...`, then pass the free-tier limits AI Studio shows for the model (the run refuses to start without all three):
`npm run eval -- --base-url https://generativelanguage.googleapis.com/v1beta/openai --model gemini-3.8-flash --rpm <N> --tpm <N> --rpd <N> --limit 3`.
For the service itself use `MODEL_PRIMARY_BASE_URL` (same URL) and `MODEL_PRIMARY_NAME`; the key is then read from `GEMINI_API_KEY`.

`npm run eval` options: `--rpm/--tpm/--rpd` (provider limits, override the Groq defaults), `--limit N` (items), `--lang en|fr`, `--items H1,T2`, `--fresh` (ignore earlier results), `--base-url` (default Groq; a local Ollama such as `http://localhost:11434/v1` needs no key). It paces itself to the Groq free plan (7,000 estimated tokens per minute, 950 requests per day), writes `eval/results/<model>.<lang>.json` and `.md` (pass rate, per-group rates, failing items with the lines that failed) after every item, and a repeat run resumes where it stopped. See `eval/items.js` for the 67 items and their expected-behaviour lines.

`npm test` uses fakes only (fake model, gateway, mailer, clock). It calls no model and no bank server and needs no key or token.

### Settings

Never put a key or token in a file in this repo. Set them in the shell that starts the service.

| Setting | What it does |
|---|---|
| nothing | Scripted stand-in model (one canned reply), no bank session. Enough for the safety and handoff steps. |
| `MODEL_PRIMARY_BASE_URL`, `MODEL_PRIMARY_NAME`, `MODEL_PRIMARY_API_KEY` | A real model. Groq: `https://api.groq.com/openai/v1`, `qwen/qwen3.8-27b`. Optional `MODEL_FALLBACK_*` (for example `openai/gpt-oss-120b`) and `MODEL_OFFLINE_*` (local Ollama, English only). Routing runs at temperature 0, answers at 0.3, so the same message is routed the same way. |
| `PORT` | Default 3000. |
| `ALLOWED_ORIGINS` | Comma-separated exact origins that may call the service from a browser page, for example `http://localhost:3001` (the portal). Empty means same-origin only. A wildcard or a path is refused at start. |
| `TEST_TOKEN`, `TEST_CLI` | Standalone demo page only: a test customer's token and cli are put on the page so a session starts against the bank's test server (`config/tenants.json`). Not used when the widget runs inside the portal. |
| `TEST_PORTAL_FLAG=1` | Standalone demo page only: also sets the portal's `isBalancePinVerified` flags. |
| `config/support.json` | Agent logins (demo: `aline` / `change-me-aline`, `paul` / `change-me-paul`), on-call rota, opening hours, timers, mail mode. Mail is log-only by default. |
| `config/navigate-routes.json` | The pages that may be linked, with each page's "Click here to …" text in EN and FR. |

Token lifetime is short. If the assistant says the session expired, sign in again (portal) or get a new token and restart (standalone).

### Standalone demo page

```sh
MODEL_PRIMARY_BASE_URL=https://api.groq.com/openai/v1 MODEL_PRIMARY_NAME=qwen/qwen3.8-27b MODEL_PRIMARY_API_KEY=... \
TEST_TOKEN=... TEST_CLI=... npm start
```

### Inside the portal (bpay-bicec)

The portal change lives on the branch `feature/bank-assistant-widget` (two files, uncommitted at the time of writing): `src/components/ChatBot.jsx` (replaces the static stub with the `<bank-assistant>` tag and loads `widget.js`) and `src/App.js` (mounts it once inside the router, so the chat survives page changes). It passes the customer's token (`localStorage.token`), `cli`, `usePackages`, `pack` and `audience` (from `localStorage.user`; `typecli "0002"` is an individual, anything else a merchant) and handles `bank-assistant:navigate` with the portal's router, so a link does not reload the page. The widget only shows to a signed-in customer.

```sh
# assistant (port 3000), with your model keys; no TEST_TOKEN needed, the portal supplies the login token
ALLOWED_ORIGINS=http://localhost:3001 npm start

# portal, on its own port
PORT=3001 REACT_APP_ASSISTANT_URL=http://localhost:3000 npm start
```

Without `REACT_APP_ASSISTANT_URL` the portal loads and shows nothing.

## Demo script (EN and FR)

Run each step in English, then in French (the reply language follows the latest message). Standalone: widget at `http://localhost:3000/`, console at `http://localhost:3000/console`. In the portal: the widget is on every signed-in page.

"Needs": **none** (works with the scripted model and no token), **model** (a real model key), **token** (a bank session: `TEST_TOKEN`/`TEST_CLI` standalone, or a portal login).

| # | Step | Type this (EN / FR) | You should see | Needs |
|---|---|---|---|---|
| 0 | Disclaimer and chip | (load the page) | Persistent line: automated assistant, may make mistakes, never asks for your PIN or OTP. A calm "Talk to a human agent" chip. | none |
| 1 | How-to | `How do I send money to another account?` / `Comment envoyer de l'argent à un autre compte ?` | A "Click here to send money" card, then steps quoting real button names, a "what I used" chip, a closing "talk to a human if" line. `How do I pay with my cat's tail?` gives "no verified steps" and the chip goes prominent. | model |
| 2 | Task links, any wording | `I want to send money`, `pay my electricity bill`, `buy airtime`, `je veux payer une facture`, `Send 5000 to 237677000555` | The matching card ("Click here to pay a bill", "…buy airtime", …) first, the steps below. Never an Overview link unless you asked for the overview. "Confirm it" / "do it for me" is refused with no link. A merchant customer gets no Transfer link. | model + token |
| 3 | Balance | `What is my balance?` / `Quel est mon solde ?` | If the portal already verified your PIN this session: the balance, no PIN prompt. Otherwise the widget's own PIN box (outside the chat). | token |
| 4 | Last transactions | `Show my last 5 transactions` / `Mes dernières transactions` | A table like the History page, full numbers, English or French headings, with a one-line summary from the model. | token + model |
| 5 | Explain my failure | `Why did my transfer <reference> fail?` | A plain reason from the failed-transfer guide and exactly one next step. A message the guide does not cover gets "I cannot tell the reason" and the human step. | token + model |
| 6 | Take me to a page | `Take me to my transaction history` / `Emmène-moi à l'historique` | A link card for the page you named. | model |
| 7 | PIN typed in chat | `my pin is 4821` / `mon code pin est 135790` | The fixed warning; the number is not shown back, not sent to the model, not in the audit. | none |
| 8 | Scam warning | `Someone called saying he is from the bank and asked me for the code I received by SMS` | A fixed scam warning and the chip goes prominent. | none |
| 9 | Drafted case message | `I sent money to the wrong person yesterday`, then click the prominent chip | The draft panel: editable text, masked details, chat/email/both, exact content before sending, then a reference. Nothing is sent before Confirm. | none (details need token) |
| 10 | Handoff and console | Confirm a chat draft; in `/console` log in as `aline` / `change-me-aline`, claim, reply | Banner with reference and elapsed time; the agent sees the draft, an AI summary labelled "may be wrong", masked records and the transcript; the bot is muted and the agent's first name and a "human agent" badge show. | none |
| 11 | Resolve and cancel | "Mark resolved" in the console; or Cancel in the banner before a claim | "Was this solved?" at resolution; cancel closes the case as "cancelled by user". | none |
| 12 | Audit (optional) | "Audit log" in the console (`aline` only) | Append-only records with masked text and no secret. | none |

Timers (5 and 15 minutes to page and queue, 10 and 30 minutes of agent silence, 24 hours, 72 hours) are config values in `config/support.json`, proven by tests with a controllable clock. To see one live, set a short value in a copy of the file and start with `SUPPORT_CONFIG=path`.

## What changed since the first demo

These came out of running it against the real model, the bank's test server and the portal.

- **Task links.** The card is built from the page the guide is about, not from the model's tag (the model kept tagging Overview). The guide's page wins unless the customer asked to be taken somewhere; Overview is linked only when asked for.
- **Over-refusal.** A task phrased as a request ("send 5000 to …") was often refused as "execute". The router is retried once with a reminder, and an answer refusal on a task guide is replaced by the steps and the link. Asking the assistant itself to complete or approve something is still refused.
- **Repeatable routing.** The model call sets a temperature (the same message was routed four different ways before).
- **Transactions table.** Dates come from `dou1` (as the portal shows), references fall back to `ntrans`, direction comes from the portal's From/To columns, nature labels from nomenclature 6000 (`/iwomicore/getNomenDataByTabcd/6000`, **not yet confirmed on the test server**: if it fails, the nature shows its code), the currency code `59`/`001` shows as XAF. Full numbers appear only in the table on the customer's own screen.
- **Output filter.** Real references (`MPU179123163935`) and ISO dates no longer look like phone numbers, and a number the customer typed may be repeated back.
- **Sessions.** The portal wrapper reads `cli`, `usePackages`, `pack` and `typecli` from `localStorage.user`. Without a session, a clear "I could not connect to your account" message replaces guesses. A rejected balance flag is audited with a shape-only reason (`not_verified`, `no_tel`, `tel_mismatch`).
- **Cross-origin.** `ALLOWED_ORIGINS` lets the portal on another port call the service.

## Seen working live (from the owner's session audit, 2026-10-13)

Session start with the portal's token and cli; balance by the portal PIN flag and by the widget's PIN box; last transactions table; explain-my-failure; page link cards (history, account history); PIN shield; a drafted case message through handoff, claim and resolve. Not yet confirmed live: scam warnings, cancel, the task links after the latest change, secondary connect, package gating, French page names, session expiry inside the portal.

## Portal checklist (manual)

These need the real portal; jsdom tests do not prove them.

- [ ] **Embed.** The widget shows on every signed-in page, its styles do not clash with the portal's (it renders unstyled inline elements today; the old stub floated bottom-right), the disclaimer and chip are visible.
- [ ] **Gating data.** With `usePackages` true and a limited package, a feature outside the package is not offered or linked (try History, Balance, Bill payment). With `usePackages` false, nothing is gated.
- [ ] **Audience.** An individual customer (`typecli "0002"`) is offered Transfer; a merchant is not.
- [ ] **Balance flag.** After the portal's PIN check, `isBalancePinVerified` is `"1"` and `isBalancePinVerified:tel` is the customer's own phone: balance shows with no PIN box. Clear the flag: the widget's PIN box appears.
- [ ] **Links.** Each "Click here" button changes page through the portal's router without a reload. For the nine pages in `config/navigate-routes.json` the card opens the page the text names; account history is not offered to a secondary connect.
- [ ] **Task links.** Send-money, bill, airtime and request-to-pay questions give the matching card first, the steps below, and never an Overview link.
- [ ] **French labels.** Page names and button texts in the French portal match the menu. Unconfirmed: "Crédit téléphonique" for airtime, and "Bill payment", which the portal prints in English in both languages.
- [ ] **Session expiry.** Let the token expire: the assistant says the session expired and does not retry.
- [ ] **Secondary connect.** Only the own wallet is read, history is said to be for the primary connect, primary-only pages are not offered.

## Open items

- The EN/FR eval harness (ticket 34) is built, but no real-model run has been made yet: there is no measured score until `npm run eval` is run with a key.
- Gap tickets 52-61 in the scratch folder: 53 (transfer status by reference times out on the test server) and 56 (explain-failure History step ignores the package) are still open.
- Hand-over items are listed in ticket 35: proof of the compliance agreement, a production model, a scoped token, a backend that binds ids to the token, a server-side balance PIN, backend logging fixes, SSO for agents, a durable case store, a real SMTP account. Production mode (`ASSISTANT_MODE=production`) refuses to start until the prerequisites are met.
