# Data Dictionary

Canonical `trials_curated.json` schema.

- `trial_id`: deterministic trial row identifier (`study_key_page`).
- `study_label`: cleaned trial label from supplementary table.
- `year`: trial publication year parsed from study label.
- `country`: trial country.
- `n_total`: randomized sample size for row.
- `dex_arm_text_raw`: dexmedetomidine arm text (multi-arm text reduced to dex arm where possible).
- `control_arm_text_raw`: comparator text.
- `control_class`: comparator class (`placebo_or_saline`, `active_control`, `mixed_control`, `unclear`).
- `bolus_value`: numeric bolus/loading dose.
- `bolus_unit`: normalized bolus unit (`mcg/kg`).
- `infusion_low`: lower bound infusion dose.
- `infusion_high`: upper bound infusion dose.
- `infusion_unit`: normalized infusion unit (`mcg/kg/h` or `mcg/h`).
- `infusion_weight_normalized`: whether infusion is weight-normalized.
- `timing_raw`: raw timing text.
- `timing_phase`: mapped timing class (`pre_op`, `intra_op`, `post_op`, `peri_multi`, `unknown`).
- `route_raw`: raw route/mode text.
- `route_std`: standardized route (`IV`, `IN`, `INH`, `PO`, `IM`, combined, or `Unknown`).
- `rob_overall_raw`: raw RoB value used (if available).
- `rob_overall_std`: standardized RoB2 class (`Low risk`, `Some concerns`, `High risk`).
- `extraction_confidence`: deterministic completeness score in `[0,1]`.
- `validation_flags`: non-critical and critical QA flags.
- `critical_flags`: subset of flags that enforce build gate.
- `needs_adjudication`: boolean, any QA flag present.
- `has_critical_issues`: boolean, any critical flag present.
- `source_page`: source supplementary-table page number.
- `source_file`: source file provenance.
- `intervention_events`: intervention delirium events text.
- `control_events`: control delirium events text.
- `assessment_tool`: delirium assessment tool text.
- `postop_icu_care`: postoperative ICU care field.

Summary files:

- `summary_overall.json`: pooled weighted metrics for all included trials.
- `summary_by_rob.json`: same metric set split by RoB class.
- `validation_report.json`: QA queue and critical issue counts.
- `review_queue.csv`: adjudication queue for flagged records.
