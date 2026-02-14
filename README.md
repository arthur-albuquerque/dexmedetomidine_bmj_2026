# Dexmedetomidine Evidence Atlas (BMJ 2026)

This app helps physicians quickly interpret how dexmedetomidine was administered across trials from the BMJ 2026 review dataset.

It is designed to answer practical clinical questions such as:
- When was dexmedetomidine given (pre-operatively, intra-operatively, post-operatively)?
- What bolus and infusion dosing patterns were used?
- How do dosing and timing patterns look across RoB2 strata?

Scope of included trials:
- Dexmedetomidine vs placebo/saline comparisons only.

Reference review:
- Luney et al., 2026, *Effectiveness of drug interventions to prevent delirium after surgery for older adults: systematic review and network meta-analysis of randomised controlled trials*.
- DOI: [10.1136/bmj-2025-085539](https://doi.org/10.1136/bmj-2025-085539)
- BMJ page: [https://www.bmj.com/content/392/bmj-2025-085539](https://www.bmj.com/content/392/bmj-2025-085539)

## View the app

- Live app: [https://arthur-albuquerque.github.io/dexmedetomidine_bmj_2026/](https://arthur-albuquerque.github.io/dexmedetomidine_bmj_2026/)

## Note

This app was built using GPT-5.3-Codex.

## Bayesian Model Script

The `brms` model fitting script is at:
- `scripts/model4_brms.R`

This script fits the Jackson Model 4 adaptation and writes model outputs to:
- `data/processed/model4_brms/`
