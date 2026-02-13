# Adjudication Guide

Use `data/processed/review_queue.csv` to resolve flagged rows before publication.

## Priority Order

1. Resolve all `critical_flags` first.
2. Resolve dose-unit ambiguities.
3. Resolve timing/route uncertainties.
4. Confirm RoB defaults and unmatched keys.

## Recommended Workflow

1. Open trial row in `trials_curated.json` using `trial_id` from queue.
2. Verify source text in supplementary table (`source_page`, `source_file`).
3. If available, verify full trial PDF under `data/raw/trial_pdfs/`.
4. Update extraction logic (preferred) rather than manually editing final JSON.
5. Re-run:

```bash
make extract
make validate
make summarize
make checksums
```

## Common Flags

- `bolus_missing`: no loading/bolus dose parsed.
- `infusion_missing`: no infusion dose parsed.
- `timing_unclear`: timing class unresolved.
- `route_unclear`: route class unresolved.
- `rob_missing_defaulted`: no valid overall RoB category found.
- `rob_unmatched_defaulted`: trial not matched to RoB workbook key.
- `infusion_out_of_range`: parsed infusion outside plausibility bounds.
- `missing_n_total`: sample size missing or invalid.

## Publish Decision Rule

Proceed to deployment only when:

- `validation_report.json.n_unresolved_critical == 0`, or
- explicit override is documented and `--allow-unresolved` is intentionally used.
