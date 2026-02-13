# Assumptions and Defaults

## Scope and Inclusion

- Include dexmedetomidine trials only when comparator is placebo/saline-like.
- Comparator include dictionary terms: `saline`, `placebo`, `equivolume saline`, `usual care`, `sham`.
- Active comparator terms are exclusionary unless placebo terms are absent.

## RoB2 Handling

- Primary source: Excel column 10 (`Overall`).
- Fallback: column 13 only if exact valid overall category.
- Otherwise default to `Some concerns` and add `rob_missing_defaulted`.

## Dosing Parsing

- Units harmonized to `mcg/kg` and `mcg/kg/h` when possible.
- `mg` doses are converted to `mcg` by multiplication by 1000.
- Fixed-rate non-weight-normalized infusion (`mcg/h`) is retained and flagged as not weight-normalized.

## Timing and Route

- Timing phase inferred from structured timing column plus intervention text.
- Route inferred from mode column plus intervention text.

## QA Gate

- Review queue contains any record with one or more validation flags.
- Build gate fails only for unresolved critical flags unless `--allow-unresolved` is set.

## Reproducibility

- Pipeline is deterministic and writes checksums for processed artifacts.
- If parquet engine is unavailable, pipeline writes deterministic CSV fallback and explicit metadata.
