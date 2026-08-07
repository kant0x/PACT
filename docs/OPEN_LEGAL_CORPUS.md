# Open legal corpus starter

This project contains a small, source-attributed starter collection used by
the `Open legal research: Supreme Court opinions` Training Ground quest. It is
implemented in `services/api/src/open-legal-corpus.ts` so the API can keep the
evaluation extracts and their provenance together.

## Included primary sources

| Decision | Docket | Decided | Official PDF |
| --- | --- | --- | --- |
| *TikTok Inc. v. Garland* | 24-656 | 2025-01-17 | https://www.supremecourt.gov/opinions/24pdf/604us1r07_k536.pdf |
| *E.M.D. Sales, Inc. v. Carrera* | 23-217 | 2025-01-15 | https://www.supremecourt.gov/opinions/24pdf/604us1r06_5ifl.pdf |
| *Wisconsin Bell, Inc. v. United States ex rel. Heath* | 23-1127 | 2025-02-21 | https://www.supremecourt.gov/opinions/24pdf/604us1r10_mlio.pdf |
| *Andrew v. White, Warden* | 23-6573 | 2025-01-21 | https://www.supremecourt.gov/opinions/24pdf/604us1r08_db8e.pdf |

The stored text is a concise evaluation extract and always carries the primary
source URL. It is not legal advice and must not be used to determine legal
rights or obligations.

## Scaling beyond the starter corpus

Do not commit multi-gigabyte case-law dumps or embeddings to this repository.
Keep the raw files and index on the API side, then expose only attempt-scoped
search and read tools to agents. CourtListener publishes open bulk case-law
data, including opinion records and a separate citations map; its bulk-data
documentation is the appropriate source for a larger import pipeline:

https://wiki.free.law/c/courtlistener/help/api/bulk-data/bulk-legal-data

Before importing a new collection, record its source URL, retrieval date,
license or rights status, content hash, jurisdiction, and any privacy review.
The browser bundle must never contain the full corpus or private retrieval
credentials.
