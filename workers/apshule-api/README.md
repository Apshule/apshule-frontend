# apshule-api

Cloudflare Worker API for the Apshule learning platform. It uses Hono, Neon Postgres, JOSE/JWT authentication, Web Crypto password hashing, and the Yo Payments XML/SOAP endpoints specified in the project brief.

## Local development

From the repository root:

```sh
cp workers/apshule-api/.dev.vars.example workers/apshule-api/.dev.vars
# Replace the example values in .dev.vars using your local editor.
pnpm install
pnpm --filter @workspace/apshule-api run dev
```

Run `schema.sql` once in the Neon SQL Editor when initializing a new database. For routine feature releases, apply only the relevant file from `migrations/`; in particular, Phase 1A uses `migrations/2026-10-04_ncdc_foundation.sql`, and Phase 2.5c uses `migrations/2026-10-04_teacher_earnings_payouts.sql`. Do not rerun the full schema on the existing Neon database. Wrangler serves the Worker locally at `http://localhost:8787`; API routes start with `/api`.

Never commit `.dev.vars` or enter secrets in chat. The example file contains placeholders only.

## Cloudflare deployment

Run these steps in order from the repository root. Wrangler prompts for each secret; enter values there, not in source files or chat.

```sh
pnpm install
pnpm --filter @workspace/apshule-api exec wrangler login
pnpm --filter @workspace/apshule-api exec wrangler secret put DATABASE_URL
pnpm --filter @workspace/apshule-api exec wrangler secret put JWT_SECRET
pnpm --filter @workspace/apshule-api exec wrangler secret put YO_API_USERNAME
pnpm --filter @workspace/apshule-api exec wrangler secret put YO_API_PASSWORD
pnpm --filter @workspace/apshule-api exec wrangler secret put YO_API_URL
pnpm --filter @workspace/apshule-api exec wrangler secret put YO_IPN_URL
pnpm --filter @workspace/apshule-api exec wrangler secret put SETTINGS_ENCRYPTION_KEY
# Initial database setup only: run workers/apshule-api/schema.sql in Neon.
# Routine updates: apply only the matching migration under workers/apshule-api/migrations/.
pnpm --filter @workspace/apshule-api run deploy
```

Use a randomly generated `JWT_SECRET` with at least 32 bytes of entropy. Set `YO_IPN_URL` to the deployed Worker URL followed by `/api/yopayments/ipn`. `YO_API_URL` is the HTTPS base URL for the Yo API; the Worker appends `/acdepositfunds` and `/actransactioncheckstatus`.

For encrypted superadmin platform settings, `SETTINGS_ENCRYPTION_KEY` must be the same 32-byte hexadecimal secret in Replit and the Cloudflare Worker. Never commit or log this value.

## API

All JSON responses use the shape shown below unless a route returns a plain-text provider acknowledgement. Authenticated routes require `Authorization: Bearer <token>`. Access tokens use HS256 and expire after 30 days. Passwords are hashed with PBKDF2-HMAC-SHA-256 through Web Crypto.

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/api/healthz` | Public | Worker health |
| POST | `/api/auth/signup` | Public | Create an individual account |
| POST | `/api/auth/login` | Public | Authenticate and issue a token |
| POST | `/api/auth/reset` | Public | Returns `503 PASSWORD_RESET_NOT_CONFIGURED` until an email delivery provider is selected |
| POST | `/api/auth/logout` | Signed in | Revoke the current token |
| GET | `/api/auth/me` | Signed in | Return current account |
| GET | `/api/users` | Superadmin | List users |
| PATCH | `/api/users/me` | Signed in | Update `name`, `phone`, `address`, or `profilePic` |
| PATCH | `/api/users/:id` | Superadmin | Change `role` to `individual`, `school`, or `superadmin` |
| DELETE | `/api/users/:id` | Superadmin | Delete a user; a superadmin cannot delete their own account |
| POST | `/api/users/me/subscription` | Signed in | Set a plan only when a matching verified payment is complete |
| GET | `/api/schools` | Public | List school records |
| POST | `/api/schools` | Superadmin | Create a school and its linked login user; requires `name`, `loginEmail`, `loginPassword` |
| PATCH | `/api/schools/:id` | Superadmin | Update `name`, `contact`, `location`, or `logo` |
| DELETE | `/api/schools/:id` | Superadmin | Delete a school and its linked users/events |
| GET | `/api/events` | Public | List events |
| POST | `/api/events` | School or superadmin | Create an event; a school account is always scoped to its own school |
| PATCH | `/api/events/:id` | School or superadmin | Update an event; school accounts can edit only their own events |
| DELETE | `/api/events/:id` | School or superadmin | Delete an event; school accounts can delete only their own events |
| GET | `/api/pdfs?class_level=Baby` | Public | List PDFs, optionally filtered by class; includes class, cover color, and display order |
| POST | `/api/pdfs` | Superadmin | Add a PDF using `title`, an absolute HTTP(S) `url`, and optional `class_level`, `cover_color`, and `display_order` |
| PATCH | `/api/pdfs/:id` | Superadmin | Update a PDF's class, cover color, display order, title, or URL |
| DELETE | `/api/pdfs/:id` | Superadmin | Delete a PDF |
| GET | `/api/video-mappings` | Public | Return `{ "key": "youtubeId" }` mappings |
| GET | `/api/video-mappings/admin` | Superadmin | List lesson mappings with teacher owners and the Education teacher choices |
| POST | `/api/video-mappings` | Superadmin | Create/update a mapping and optionally assign or clear its teacher owner |
| GET | `/api/subjects` | Public | Return `{ "primary": [], "secondary": [] }` |
| PUT | `/api/subjects/:level` | Superadmin | Replace `subjects` for `primary` or `secondary` |
| GET | `/api/feedbacks?limit=50` | Superadmin | List feedback, capped at 200 rows |
| POST | `/api/feedbacks` | Public | Submit feedback; rating, if supplied, must be 1–5 |
| POST | `/api/video-views` | Signed-in learner or teacher | Record a mapped lesson view; identity and teacher ownership are server-derived, self-views are excluded, and repeats are deduplicated for 24 hours |
| GET | `/api/video-views/stats` | Superadmin | View totals grouped by subject and class |
| GET | `/api/teacher/earnings` | Teacher | Get lifetime, monthly, pending-payout, available-balance, and current-rate totals |
| GET | `/api/teacher/earnings/breakdown?from=&to=` | Teacher | Get daily view and earnings rows for a date range (defaults to the last 30 days) |
| GET | `/api/teacher/earnings/report.pdf?from=&to=` | Teacher | Download an on-demand PDF earnings report |
| GET | `/api/teacher/payouts` | Teacher | List the signed-in teacher's payout history |
| POST | `/api/teacher/payouts/request` | Teacher | Request a manual withdrawal using `amount`, `payment_method`, and optional `notes` |
| GET | `/api/superadmin/payouts?status=&teacher_id=` | Superadmin | Filter payout requests and see teacher details and admin totals |
| PATCH | `/api/superadmin/payouts/:id/approve` | Superadmin | Approve a pending payout and optionally add notes |
| PATCH | `/api/superadmin/payouts/:id/paid` | Superadmin | Record a manual payment reference and allocate the paid amount to lesson earnings |
| PATCH | `/api/superadmin/payouts/:id/reject` | Superadmin | Reject a pending payout with a required reason |
| GET | `/api/superadmin/earnings/rate` | Superadmin | Get the global per-view rate and minimum withdrawal |
| PATCH | `/api/superadmin/earnings/rate` | Superadmin | Update the global per-view rate and minimum withdrawal |
| GET | `/api/uneb-items?subject=&class_level=` | Teacher, school, or superadmin | List UNEB assessment items with optional exact filters |
| POST | `/api/uneb-items` | Superadmin | Create a UNEB item; `created_by` is derived from the session |
| PATCH | `/api/uneb-items/:id` | Superadmin | Update an UNEB item |
| DELETE | `/api/uneb-items/:id` | Superadmin | Delete an UNEB item |
| GET | `/api/curriculum-links?subject=&class_level=&q=` | Teacher, school, or superadmin | List and search curriculum references |
| POST | `/api/curriculum-links` | Superadmin | Create a curriculum link |
| PATCH | `/api/curriculum-links/:id` | Superadmin | Update a curriculum link |
| DELETE | `/api/curriculum-links/:id` | Superadmin | Delete a curriculum link |
| GET | `/api/ncdc/stats` | Superadmin | Return UNEB, curriculum-link, project, and CA record counts |
| GET | `/api/ca-records?learner_id=&school_id=&term=` | Individual, teacher, school, or superadmin | Individuals see their own records; school staff are restricted to their linked school |
| POST | `/api/ca-records` | Teacher, school, or superadmin | Create a CA record; learner and school ownership are validated |
| PATCH | `/api/ca-records/:id` | Teacher, school, or superadmin | Update a record within the caller's school scope |
| GET | `/api/projects?learner_id=&school_id=&class_name=&subject=` | Individual, teacher, school, or superadmin | Individuals see their own projects; school staff are restricted to their linked school |
| POST | `/api/projects` | Individual, teacher, school, or superadmin | Create a project; non-admin ownership IDs are derived or scope-checked |
| PATCH | `/api/projects/:id` | Teacher, school, or superadmin | Update a project within the caller's school scope |
| GET | `/api/teacher-retooling-progress/:teacher_id` | Teacher (own), school, or superadmin | Read a teacher's module progress within the caller's scope |
| POST | `/api/teacher-retooling-progress` | Teacher, school, or superadmin | Create a teacher module progress record |
| PATCH | `/api/teacher-retooling-progress/:id` | Teacher, school, or superadmin | Update progress within the teacher or school scope |
| GET | `/api/settings/brand` | Public | Get brand settings |
| PUT | `/api/settings/brand` | Superadmin | Replace brand settings with a JSON object |
| GET | `/api/settings/about` | Public | Get about settings |
| PUT | `/api/settings/about` | Superadmin | Replace about settings with a JSON object |
| POST | `/api/yopayments/initiate` | Signed in | Create a UGX payment and initiate Yo deposit |
| POST | `/api/yopayments/status` | Owner or superadmin | Check a payment by `reference` |
| POST | `/api/yopayments/ipn` | Public callback | Acknowledge with plain-text `OK` after checking provider status server-side |

Mutations to UNEB items, CA records, projects, curriculum links, and teacher retooling progress write their actor, `sector='education'`, action, target, request IP, and limited metadata to `audit_log` in the same database statement.

Teacher views are attributed to the owner saved on the lesson mapping, not a browser-supplied teacher ID. A viewer must have a valid session, and payout changes/rate changes are restricted to a real Super Admin session. Available balance subtracts pending, approved, and paid payouts; paid amounts are allocated oldest-view-first, including partial view allocations. Payouts remain manual—no payment provider is called.

### Request examples

Signup:

```json
{
  "name": "Amina",
  "email": "amina@example.com",
  "phone": "+256700000000",
  "password": "use-a-long-password",
  "educationLevel": "secondary"
}
```

School creation:

```json
{
  "name": "Example School",
  "contact": "Main office",
  "location": "Kampala",
  "logo": "https://example.com/logo.png",
  "loginEmail": "admin@example-school.ug",
  "loginPassword": "use-a-long-password",
  "phone": "+256700000000"
}
```

Payment initiation:

```json
{
  "plan": "annual",
  "amount": 50000,
  "phone": "+256700000000",
  "email": "amina@example.com",
  "name": "Amina",
  "reference": "aps-2026-unique-reference"
}
```

The payment amount is accepted in the request to match the supplied API contract. Before public launch, enforce plan prices on the server rather than trusting a client-provided amount.

## Yo Payments wire format

The client sends HTTPS `POST` requests with HTTP Basic authentication and `Content-Type: text/xml`. It uses a SOAP 1.1 envelope and the operation names `/acdepositfunds` and `/actransactioncheckstatus`; parsed provider status is checked before the API activates a subscription. Verify the exact operation element and field names against the Yo Payments account's current API documentation or sandbox before processing live money.

## Important limitations

- Password reset explicitly returns `503` until an email-delivery provider and reset-confirmation flow are configured; it does not claim to send an email.
- The payment request format follows the fields in the supplied project brief. Confirm it with Yo's current docs/sandbox before production transactions.
- CORS allows all origins as requested. Restrict origins before exposing authenticated endpoints publicly if the consuming apps have known domains.
- Public signup always creates the `individual` role. To establish the first superadmin, create an account through `/api/auth/signup`, then have a trusted operator promote that exact email in Neon:

  ```sql
  UPDATE users SET role = 'superadmin' WHERE lower(email) = lower('admin@example.com');
  ```

- `POST /api/users/me/subscription` requires a matching verified, completed payment; it cannot grant a free subscription.