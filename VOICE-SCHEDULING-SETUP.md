# Phone scheduling (Twilio)

A patient calls one of your numbers, the call answers itself, and — if it
finds an open slot — the appointment lands on the Schedule calendar before
the patient hangs up. No staff time spent on routine "I'd like to make an
appointment" calls.

```
Patient's phone  →  Twilio number  →  /api/voice-schedule  →  Postgres (app_records)
                                                             ↳  Schedule calendar
                                                             ↳  confirmation text (Twilio SMS)
```

This only works once the app is deployed to Netlify with `DATABASE_URL` set
(the 'api' data mode) — see `BACKEND-SETUP.md` for that part first. A phone
call has nowhere to write to if the app is still running only inside a
browser.

## 1. Buy a number and point it here

In the Twilio console, under **Phone Numbers → Manage → Active numbers**,
open the number you bought for this practice. Under **Voice Configuration**,
set:

- **A call comes in:** Webhook
- **URL:** `https://<your-site>.netlify.app/api/voice-schedule`
- **HTTP method:** `POST`

Do this once per Twilio number. A practice with several locations, each with
its own line, repeats this for each number.

## 2. Tell ReviFlow which organization each number belongs to

**Admin → Organizations** → open the organization → **Appointment phone**.
Enter the *same* number you just configured in Twilio (any common format is
fine — `(512) 555-0120`, `512-555-0120`, `+15125550120`; only the digits are
compared). The webhook looks up which organization owns the dialed number so
one function can serve every location without any per-number code.

If a practice has only one organization record, the appointment phone field
doesn't strictly need to match — the webhook falls back to that one
organization automatically. It matters as soon as there is more than one.

## 3. Make sure each clinician's availability is filled in

**Admin → Providers** → the **Availability** field (free text, e.g.
`Mon–Fri, 08:00 – 17:00`, or `Tue and Thu, 9am - 1pm`). This is the only
thing the phone system reads to know when a clinician can be booked — it is
read leniently (weekday ranges, comma/"and"-separated day lists, 12- or
24-hour times) but falls back to weekdays 8am–5pm if it can't make sense of
what's there, so it's worth checking that each clinician who should be
phone-bookable has something in it.

## 4. Confirm the environment variables are set

These are the same ones the patient-portal text messages already use — if
sign-in codes are texting out successfully, this step is already done:

| Variable | Used for |
|---|---|
| `TWILIO_ACCOUNT_SID` | required — without it the call is declined |
| `TWILIO_AUTH_TOKEN` | required — also verifies every call really came from Twilio |
| `TWILIO_FROM` | the number confirmation texts are sent from |
| `SITE_URL` | builds the webhook's own callback URLs between steps |
| `SCHEDULING_TZ` *(optional)* | IANA time zone, e.g. `America/Chicago`. Falls back to `CLAIMS_TZ`, then `America/Chicago`. Controls what "today" and "the next opening" mean — set it to the practice's actual time zone. |

## 5. Call it and try it

Dial the number. The flow is:

1. *"Thanks for calling \<practice\>."* — if the organization has more than
   one clinician, a quick menu ("press 1 for Dr. A, press 2 for Dr. B…")
   comes first; with one clinician it's skipped.
2. *"Can I get the first and last name of the patient?"* (spoken)
3. *"Please enter the date of birth…"* (keypad, MM DD YYYY)
4. *"What is this appointment for?"* (spoken, becomes the appointment's reason)
5. *"The next opening with \<clinician\> is \<day, date, time\>. Press 1 to
   book it, 2 for another time, 9 for the office to call you instead."*

Pressing 1 books it immediately as a normal **Scheduled** appointment —
indistinguishable in Schedule, Insights, or anywhere else from one a
scheduler typed in by hand, except that it's tagged `booked_mode: 'A'`
(automatic) and `booked_by: 'Phone (automated)'` so it's easy to see which
appointments came in this way. A confirmation text goes to the caller's
number if `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_FROM` are set.

If the caller's name and date of birth match an existing patient (by last
name plus either date of birth or the calling phone number already on file),
the appointment links to that patient record. If not, the appointment still
books — with the name and date of birth spoken on the call — and is simply
not yet linked to a chart, exactly as when a scheduler books a walk-in over
the phone today and fills in the rest afterward.

## What this deliberately does not do

- **No voicemail / fallback human transfer.** If nothing can be found —
  wrong number, no clinicians configured, no openings in the next 45 days —
  the call ends with "please call the office directly." Wiring this into a
  real transfer (`<Dial>` to a front-desk line) is a small addition once you
  have a number to send it to.
- **No rescheduling or cancellation by phone.** This handles new bookings
  only.
- **Up to 9 clinicians per organization** can be offered by keypress (digits
  1–9). A tenth clinician at the same organization won't appear in the
  phone menu.
