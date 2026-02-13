# Dexmedetomidine Dosing & Timing Evidence Atlas

Static evidence atlas for dexmedetomidine administration (dose + timing) in placebo/saline-controlled trials from the BMJ delirium review source files.

## Assumptions + Missing Info Checkpoint

- Scope is fixed to dexmedetomidine vs placebo/saline controls only.
- Primary data source is `data/raw/delirium_list_of_articles.pdf` + `data/raw/delirium_rob.xlsx`.
- Optional full-text enrichment is enabled when trial PDFs are added under `data/raw/trial_pdfs/`.
- RoB2 precedence is column 10 (`Overall`) then valid fallback category in column 13; otherwise defaults to `Some concerns` with explicit flag.
- Strict QA gate blocks release only when unresolved **critical** flags remain.

## Repository Layout

- `data/raw/` source artifacts and optional trial PDFs
- `data/interim/` extracted intermediate tables
- `data/processed/` curated trial-level and summary outputs
- `scripts/` extraction, validation, summary, and sync scripts
- `tests/` deterministic unit tests
- `docs/` static build output for GitHub Pages

## Deterministic Runbook

```bash
make extract
make validate
make summarize
make checksums
make sync-data
make test
```

Or run all steps:

```bash
make all
```

Extraction always runs from the supplementary PDF table plus RoB workbook:

```bash
.venv/bin/python scripts/extract_data.py
```

## Outputs

- `data/processed/trials_curated.json`
- `data/processed/summary_overall.json`
- `data/processed/summary_by_rob.json`
- `data/processed/review_queue.csv`
- `data/processed/validation_report.json`
- `data/processed/checksums.json`

Manual adjudications can be added in:

- `data/raw/manual_adjudications.json`

These are keyed by normalized study key (e.g., `li_2023`) and are applied during extraction.

## Parquet Note

The pipeline attempts parquet writes for interim files. If no parquet engine is available, it writes deterministic CSV fallbacks and metadata files:

- `*.parquet.csv`
- `*.parquet.meta.json`

This is explicit and non-silent by design.

## Deploy to GitHub Pages

The workflow in `.github/workflows/deploy-pages.yml`:

1. installs Python dependencies,
2. runs extraction/QA/summaries/tests,
3. syncs processed data to `docs/data/`,
4. deploys via GitHub Pages artifact.

## Stage-2 Full-Text Enrichment

Place trial PDFs in `data/raw/trial_pdfs/` with filenames that contain study labels (e.g., `Deiner_2017.pdf`). The extractor automatically applies full-text precedence for dose fields when parsable.
