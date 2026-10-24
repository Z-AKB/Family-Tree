# Family Tree App

Express + SQLite backend with a vanilla JS frontend served from `public/`.

## Run
    npm test             # 8 automated API tests
    npm run check:responsive   # optional layout check, see tools/responsive-check.js
    npm install
    npm start            # http://localhost:3000
Demo login: demo@family.test / demo1234 (seeded with the Whitmore family on first run).
Set `JWT_SECRET` in production. The database is `family.db`; photos are saved in `uploads/`.

## Features
- Relationship types: married, partners, divorced or separated (with start and end years), and adopted, step or foster children. They carry through GEDCOM and the relationship finder ("stepson").
- Tidy up: finds likely duplicate people and merges them (relationships, children, photos and notes move across), and flags impossible dates such as a mother who would have been 6, or people not connected to the tree.
- Sources, documents and a photo album for each person (images or PDF up to 5 MB, or a web link). Living people's files stay hidden from visitors. A button opens a FamilySearch record search for the person in a new tab.
- Accounts: forgot-password by email, change password (signs out other devices), change name, delete account.
- Languages: English, French, Spanish and Hausa, chosen from the header. Hausa is a first draft and needs review by a native speaker. Names, notes and anything people type are never translated.
- Charts: a connected family chart (zoom, drag, choose how many generations, print) and an ancestors chart for any person.
- Add parents to anyone, including a spouse, so the tree grows upward. "Start the tree from here" moves the top of the tree to an ancestor.
- Places of birth and death, and an "About this person" story for each member.
- "How are we related?" works out sibling, cousin, aunt or uncle, grandparent, half and in-law relationships.
- Insights: people, generations, lifespans, common names and upcoming birthdays.
- Install it on a phone or desktop (it is a web app with a manifest and offline shell). Print any page. Download a full JSON backup.
- Five designs to choose from with the Design button: Sunny, Heritage, Midnight, Blossom and Clean (high contrast). The choice is remembered on that device, and first-time visitors on a dark-mode device get Midnight.
- Works on phones, tablets and desktops (checked at 360, 390, 768, 1280 and 1920 px wide in all five designs). Buttons are at least 44px tall, and the menu becomes a swipeable row on phones.
- Search for a family member by name from any tree page.
- Hardened: security headers, a limit on sign-in attempts, no inline scripts, and the server refuses to start in production without `JWT_SECRET`.
- Viewer: tree with multiple spouse branches, offspring toggle, grandchildren page, full person pages. Trees can be shared by link (`#/t/<id>`), read-only for visitors.
- Owner: create and rename trees, add spouses and children, edit details, upload photos, remove people.
- Privacy: trees are private by default. Shared links hide full birth dates and photos of living people.
- Roles: invite existing accounts as editor or viewer. Every change is recorded in a history page.
- Import a GEDCOM file as a new tree, or merge one into a tree (safe to repeat). Export one too (optionally without living people's details). See ARCHITECTURE.md.
- Large trees load a few generations at a time; deeper branches load when opened.
- Dates can be partial (1932, 1932-03) and marked about, before or after.
- Status (Alive/Deceased) and age are derived from D.O.B and D.O.D on the server.

## API
| Method | Path | Purpose |
|---|---|---|
| POST | /api/auth/register, /api/auth/login | Accounts (returns JWT) |
| GET/POST | /api/trees | List mine / create a tree with its first person |
| GET/PATCH/DELETE | /api/trees/:id | Read (public) / rename / delete |
| POST | /api/trees/:id/people | Add a person: `spouse_of` (+ `year`) or `parent_marriage_id` |
| PUT/DELETE | /api/people/:id | Edit / remove (blocked if they have children) |
| POST | /api/people/:id/photo | Upload `photo` (multipart, 3 MB max) |
| GET | /api/people/:id/relatives | Ancestors and descendants (recursive CTE, `?depth=`) |
| GET/POST/DELETE | /api/trees/:id/members | Invite, list, remove collaborators (owner) |
| GET | /api/trees/:id/history | Change history (owner, editor) |
| GET | /api/trees/:id/export.ged | GEDCOM export, `?hideLiving=1` |
| POST | /api/trees/import?name= | New tree from a GEDCOM file (text body) |
| POST | /api/trees/:id/import | Merge a GEDCOM file into a tree |
| GET | /api/trees/:id?depth=N | First person plus N generations |
| GET | /api/people/:id/branch | A person's spouses, children and parents |
| POST | /api/people/:id/parents | Add a father and mother (once) |
| GET | /api/people/:id/pedigree | Ancestors for the chart (`?depth=`) |
| GET | /api/people/:a/related/:b | How two people are related |
| GET | /api/trees/:id/insights | Counts, lifespans, names, birthdays |
| GET | /api/trees/:id/export.json | Full backup |
| PUT | /api/marriages/:id | Change kind (married, partner, divorced, separated) and years |
| GET | /api/trees/:id/duplicates | Likely duplicate people |
| POST | /api/people/:id/merge | Merge this person into `into` |
| GET | /api/trees/:id/checks | Impossible dates and unconnected people |
| GET/POST | /api/people/:id/attachments | Photo album, sources, documents |
| DELETE | /api/attachments/:id | Remove one |
| POST | /api/auth/forgot, /api/auth/reset | Password reset by email |
| GET/PATCH/DELETE | /api/me, POST /api/me/password | Account settings |

## Data model
users, trees (root_id, visibility, hide_living), members, audit, people (dob, dod, parent_marriage_id), marriages (a_id, b_id, year).
A child belongs to a marriage, which is what lets one person have several spouses with separate offspring.

## Email
Set `SMTP_URL` (for example `smtps://user:pass@smtp.example.com`), `MAIL_FROM` and `APP_URL` (your public address) so password-reset emails are sent. Without `SMTP_URL`, messages are printed to the console outside production, so you can test the flow.

## Hosting
`docker build -t family-tree . && docker run -p 3000:3000 -e JWT_SECRET=<long random string> -v familytree:/data family-tree`
The database and photos live in `DATA_DIR` (`/data` in Docker), so mount a volume there. See `.env.example`.
