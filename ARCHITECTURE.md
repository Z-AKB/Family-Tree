# Architecture

```
Browser (public/index.html, hash-routed single page)
   |  JSON over HTTPS, JWT in Authorization header
Express API (server.js)  -- auth, roles, privacy filter, audit log, GEDCOM export
   |
SQLite (better-sqlite3)  -- users, trees, people, marriages, members, audit
Disk (uploads/)          -- profile photos and attachments
```

## Decisions and what they are based on

| Decision | Why | Source |
|---|---|---|
| People plus marriages ("families"); a child points to the marriage it came from | Same shape as GEDCOM INDI and FAM records, so export is lossless and one person can have several spouses with separate offspring | https://tng.lythgoes.net/wiki/index.php/Gedcom_Data_Model , https://gist.github.com/gra-moore/3205436 |
| Status and age derived from D.O.B / D.O.D, never stored | Avoids contradictory data; "living" is also what privacy rules key off | spec, plus https://www.familysearch.org/en/help/helpcenter/article/who-can-see-my-living-relatives-in-family-tree |
| Unique index on each couple, indexes on parent and marriage lookups | Let the database guarantee no duplicate relationships, as f-tree does with its edge index | https://github.com/thisisankit27/f-tree |
| Recursive CTEs for ancestors and descendants, depth-capped | Family data is a graph, not a strict hierarchy, so nested sets and materialized paths fit poorly; cap generations so queries stay cheap | https://dev.to/dusttoo/building-a-multi-generation-pedigree-tree-in-postgresql-288 |
| Trees private by default; shared links hide full birth dates and photos of living people | Standard genealogy practice: living people are hidden or reduced to surname and sex in anything shared | https://chronoplexsoftware.com/myfamilytree/help/privacy.htm , https://familytreemagazine.com/premium/strategies/better-privacy-online/ |
| Owner, editor and viewer roles | Family group trees share access with relatives while keeping control with the owner | FamilySearch family group trees (link above) |
| Audit log of every change | FamilySearch keeps change history for tree edits | FamilySearch help center (link above) |
| GEDCOM 5.5.1 export, with a "hide living" option | GEDCOM is the common exchange format; exports usually let you suppress living people | https://gedcomx.org , https://familytreemagazine.com/premium/strategies/better-privacy-online/ |

| GEDCOM import that is safe to repeat | People already in the tree (same GEDCOM id, or same name and birth date) are left untouched, so re-importing changes nothing | https://github.com/thisisankit27/f-tree |
| Load a few generations first, then one ring at a time | A tree of thousands opens as fast as a tree of ten (`?depth=` and `/people/:id/branch`) | https://github.com/thisisankit27/f-tree |
| Partial and approximate dates (1932, 1932-03, about / before / after) | Genealogy dates are often incomplete; GEDCOM carries the same qualifiers | https://stat.ethz.ch/CRAN/web/packages/tidygedcom/vignettes/v000_getting-started.html |

| Search queries the database, not the loaded page | With generation-by-generation loading, most people are not on the page yet | https://github.com/thisisankit27/f-tree |
| Descendant and ancestor charts drawn as SVG | Every major site offers chart views; plain SVG needs no library and prints cleanly | https://familytreemagazine.com/premium/websites/online-family-trees-compared/ |
| Relationship finder from the nearest shared ancestor | Generations up on each side give the name (cousin, once removed, great-uncle); marriage links give in-laws | GEDCOM family model (links above) |
| Places and stories on each person | Standard GEDCOM PLAC and NOTE fields, carried through import and export | https://tng.lythgoes.net/wiki/index.php/Gedcom_Data_Model |
| Installable web app (manifest and service worker) | Phone access matters to family users; the shell works offline, family data always comes from the server | https://familytreemagazine.com/premium/websites/online-family-trees-compared/ |
| Relationship kind lives on the couple; adopted, step and foster live on the child's link | Matches how GEDCOM records divorce (DIV) and PEDI; step relatives are family but not blood relatives | GEDCOM family model (links above) |
| Merge moves relationships instead of deleting them | A repeat can hold a spouse, children or photos; two records for the same couple collapse into one | https://github.com/thisisankit/f-tree |
| Sessions carry a version that changes with the password | Changing or resetting a password signs out every other device | OWASP session guidance |
| Reset links are random, stored only as a hash, expire in one hour, and work once; the page never reveals whether an email has an account | Standard account-recovery hardening | OWASP forgot-password guidance |
| Changing a password also deletes every outstanding reset link in the same transaction | A stolen old reset link must not reopen an account after the password changes | OWASP forgot-password guidance |
| Demo data is seeded only outside production, or when `SEED_DEMO=1`; the login hint appears only when the demo account actually exists | Production deployments should not advertise or create known credentials | n/a |
| JWTs are signed and verified with HS256 only; email, name, and password inputs are normalized and length-checked | Prevents algorithm confusion, duplicate/case-variant accounts, and oversized bcrypt inputs | https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html |
| Sign-in, reset, and password-change limits count failures by direct socket IP, not by email or successful requests | An attacker cannot dodge the limit by changing the email; normal users are not penalized | OWASP authentication guidance |
| Translations match the English text the app draws, from one data file | Adding a language is one more entry per row, and a test fails if any phrase is missing | n/a |
| Uploads are checked by magic bytes and must match their extension and declared type | A renamed executable or a file with a spoofed MIME type is rejected before it is stored | https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html |
| Stored files are served only through permission-checked routes, and the browser fetches them with the session token as blob URLs | The uploads folder is never public, while shared links still follow the same living-person rules | OWASP file upload guidance (link above) |
| Files are removed only after a successful database change, and only when no remaining row references them | Deleting or merging a person does not leave orphans or break a photo shared by two records | n/a |

## Operations
- Tests: `npm test` covers sign-in, validation, rate limits, reset invalidation, error handling, roles, privacy, dates, loading, search, browser routes, and GEDCOM round trips.
- Layout: `tools/responsive-check.js` loads every page at five screen sizes in every design and flags sideways overflow and small touch targets.
- Designs: each design is a block of CSS variables (colours, fonts, corner radii) on `:root[data-theme]`, so adding one is about 15 lines. `theme.js` applies the saved choice before the page paints.
- Security: security headers, HS256-pinned JWTs, failure-based auth rate limits, 200 KB JSON limit, magic-byte upload checks, permission-checked media routes, safe error responses, demo seeding disabled in production by default, and production refuses to start without `JWT_SECRET`.
- Proxy: Express `trust proxy` is off, so `X-Forwarded-For` is not trusted. A reverse proxy makes all clients share its IP for rate limiting; tune `AUTH_LIMIT` accordingly.
- Deployment: Dockerfile with a `/data` volume. SQLite suits one server; move to PostgreSQL to run several.

## Not built yet (known next steps)
- Record hints and DNA matching. These need large paid record databases and lab partners. The app links out to FamilySearch's public search instead.
- More languages, and a native-speaker review of the Hausa draft. Some sentences made by the server (such as relationship answers) are still English.
- Email verification when signing up.
- Source citations shown in GEDCOM export (files and sources are stored but not exported yet).
