# Open legal corpus

This project contains a small, source-attributed starter collection used by
the `Legal evidence dossier` agent-training profile. It is
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

## Production corpus: 5,000 reviewed documents

Do not commit multi-gigabyte case-law dumps or embeddings to this repository.
Keep the 3–10 GB raw PDF/CSV archive in storage controlled by the API operator.
The API accepts a compact runtime pack of **reviewed evidence cards**, and sends
an agent only a new, attempt-scoped dossier (at most 24 documents) through the
search/read MCP tools. The browser receives neither the corpus nor an answer
key.

CourtListener publishes open bulk case-law data, including opinion records and
a separate citations map. Its documentation describes the CSV format, snapshot
schedule, source links, and rights notice:

https://wiki.free.law/c/courtlistener/help/api/bulk-data/bulk-legal-data

The importer is [prepare_open_legal_corpus.py](../training/prepare_open_legal_corpus.py).
It reads CourtListener's `opinions` and optional `opinion_clusters` CSV files,
then writes a source-attributed JSONL runtime pack and an audit manifest. Raw
data is deliberately written below `data/`, which is ignored by Git.

```powershell
python training/prepare_open_legal_corpus.py `
  --opinions D:\legal-source\opinions-YYYY-MM-DD.csv `
  --clusters D:\legal-source\opinion-clusters-YYYY-MM-DD.csv `
  --reviewed-cards D:\legal-source\reviewed-cards.jsonl `
  --output data\legal-corpus\courtlistener-reviewed.jsonl `
  --manifest data\legal-corpus\courtlistener-reviewed.manifest.json `
  --limit 5000
```

`reviewed-cards.jsonl` contains one JSON object per approved evaluation card:

```json
{"sourceOpinionId":"123456","sourceUrl":"https://official-court.example/opinion.pdf","question":"What controlling rule did the court apply?","answer":"…","evidenceSelectors":["exact phrase in the source","second exact phrase in the source"]}
```

The importer rejects cards unless both evidence selectors are present in the
source text. The API rejects runtime packs without a manifest, primary source
URL, reviewed answer, and two scoped evidence chunks. This prevents an
unreviewed generated question from becoming a point-scored training run.

Configure the hardened API with the exported compact pack, not the raw archive:

```text
PACT_OPEN_LEGAL_CORPUS_PATH=/data/legal-corpus/courtlistener-reviewed.jsonl
```

The first release may use the four official SCOTUS starter cards when this
variable is unset. Once the reviewed pack is mounted, its document count becomes
the number of legal-run variants and each agent receives a distinct dossier.

Before importing a new collection, record its source URL, retrieval date,
rights status, content hash, jurisdiction, and any privacy review. Do not mix
sealed records or personal data into the open legal corpus.
