# Connecting the eligibility page to Stedi

The browser never talks to Stedi directly — the API key would be readable in
page source and Stedi blocks cross-origin browser calls. A Netlify Function
sits in between.

```
eligibility.html  →  POST /api/eligibility  →  netlify/functions/eligibility.js  →  Stedi
                     (no key in browser)        (key read from env var)
```

## One-time setup

**1. Add the key in Netlify**

Site configuration → Environment variables → Add a variable

```
Key:   STEDI_API_KEY
Value: <your Stedi API key>
```

Set it for all deploy contexts, then **Deploys → Trigger deploy → Clear cache
and deploy site**. Environment variables are only picked up on a fresh build.

**2. Push these files**

```
netlify.toml                      functions dir + /api/eligibility redirect
netlify/functions/eligibility.js  the proxy
.env.example                      placeholder, safe to commit
.gitignore                        keeps .env out of git
```

That is the whole setup. No build step, no server to keep running.

## Testing locally (optional)

```bash
npm i -g netlify-cli
cp .env.example .env      # then paste your real key into .env
netlify dev               # serves the site AND the function
```

`netlify dev` is only for local testing. The deployed site does not need it.

## Which key to use

Stedi issues test and production keys. A **test key** returns Stedi's mock
payloads and only matches specific member details — anything else comes back as
an AAA error, which is expected. Use these to confirm the pipe works:

| Payer | Member ID | First / Last | DOB | Expect |
|---|---|---|---|---|
| Aetna (60054) | `1234567890` | Jane Doe | 1980-01-01 | Active coverage |
| UnitedHealthcare (87726) | `0000000000` | John Doe | 1970-05-15 | Active coverage |
| Any | `AAA72` | any | any | AAA-72 error view |

Confirm the exact mock values against Stedi's current docs before relying on
them — they are versioned and do change:
<https://www.stedi.com/docs/healthcare/api-reference/mock-requests-eligibility-checks>

Swap to a production key and real member data returns real coverage. Nothing in
the UI changes.

## Field mapping

| Form field | Stedi field |
|---|---|
| Select payer | `tradingPartnerServiceId` (ID parsed from the label) |
| Choose facility | `provider.organizationName` |
| NPI | `provider.npi` |
| Tax ID | `provider.taxId` |
| Member first / last name | `subscriber.firstName` / `subscriber.lastName` |
| Date of birth | `subscriber.dateOfBirth` (converted to `YYYYMMDD`) |
| Member ID | `subscriber.memberId` |
| Category | `encounter.serviceTypeCodes[0]` (code parsed from the label) |
| Date of service | `encounter.dateOfService` |
| CPT code | `encounter.procedureCode` |
| Relationship ≠ Self | adds a `dependents[]` entry; subscriber name fields switch to the subscriber |

`controlNumber` is generated per request in the function if absent.

## Status badge

The chip under the page title reports the state of the connection:

- **Live · Stedi connected** — the function answered
- **Offline · deploy to Netlify for live results** — you opened the HTML file
  directly, so `/api/eligibility` does not exist

## Security notes before go-live

- The key is only in the Netlify environment. Never put it in any file under
  version control, and never in client-side JS.
- Add authentication in front of the function. As written, anyone who finds the
  URL can spend your Stedi quota. Netlify Identity, a shared secret header, or
  a JWT check inside the handler all work.
- Eligibility responses contain PHI. Do not log the full response body, and
  keep the `sessionStorage` copy that feeds the detail page in mind when you
  set your session policy.
