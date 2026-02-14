# ============================================================
# Jackson et al. (Stat Med 2018) - Model 4 in brms
#
# Target model (paper's lme4 form):
# glmer(cbind(event, n-event) ~ factor(study) + factor(treat) +
#       (treat12 - 1 | study), family = binomial(link = "logit"))
#
# Data source:
# data/processed/delirium_prevalence_arm_level.csv
#
# Output directory:
# data/processed/model4_brms
# ============================================================

suppressPackageStartupMessages({
  library(dplyr)
  library(readr)
  library(stringr)
  library(tibble)
  library(brms)
  library(posterior)
  library(ggdist)
  library(metafor)
  library(patchwork)
  library(bayesmeta)
})


# ------------------------------------------------------------
# Settings
# ------------------------------------------------------------

input_path <- Sys.getenv("MODEL4_INPUT", unset = "data/processed/delirium_prevalence_arm_level.csv")
output_dir <- Sys.getenv("MODEL4_OUTPUT_DIR", unset = "data/processed/model4_brms")

seed <- as.integer(Sys.getenv("MODEL4_SEED", unset = "20260214"))
chains <- as.integer(Sys.getenv("MODEL4_CHAINS", unset = "4"))
iter <- as.integer(Sys.getenv("MODEL4_ITER", unset = "4000"))
warmup <- as.integer(Sys.getenv("MODEL4_WARMUP", unset = "2000"))
cores <- as.integer(Sys.getenv("MODEL4_CORES", unset = "4"))
backend <- Sys.getenv("MODEL4_BACKEND", unset = "cmdstanr")  # "cmdstanr" or "rstan"

if (!backend %in% c("cmdstanr", "rstan")) {
  stop("MODEL4_BACKEND must be 'cmdstanr' or 'rstan'.")
}
if (warmup >= iter) {
  stop("MODEL4_WARMUP must be smaller than MODEL4_ITER.")
}


# ------------------------------------------------------------
# 1) Read and validate comparison-level counts
# ------------------------------------------------------------

arm_df <- readr::read_csv(input_path, show_col_types = FALSE)
has_study_label_col <- "study_label" %in% names(arm_df)
has_dex_arm_label_col <- "dex_arm_label" %in% names(arm_df)

required_cols <- c(
  "trial_id",
  "dex_arm_index",
  "dex_events",
  "dex_total",
  "control_events",
  "control_total"
)

missing_cols <- setdiff(required_cols, names(arm_df))
if (length(missing_cols) > 0) {
  stop("Missing required columns: ", paste(missing_cols, collapse = ", "))
}

arm_df <- arm_df %>%
  mutate(
    trial_id = as.character(trial_id),
    study_label = if (has_study_label_col) as.character(study_label) else NA_character_,
    dex_arm_label = if (has_dex_arm_label_col) as.character(dex_arm_label) else NA_character_,
    dex_arm_index = as.integer(dex_arm_index),
    dex_events = as.integer(dex_events),
    dex_total = as.integer(dex_total),
    control_events = as.integer(control_events),
    control_total = as.integer(control_total),
    comparison_id = paste0(trial_id, "__arm", dex_arm_index)
  )

if (anyNA(arm_df$trial_id) || any(trimws(arm_df$trial_id) == "")) {
  stop("trial_id contains missing/empty values.")
}
if (anyNA(arm_df$dex_arm_index)) {
  stop("dex_arm_index contains missing/non-integer values.")
}
if (anyNA(arm_df$dex_events) || anyNA(arm_df$dex_total) ||
    anyNA(arm_df$control_events) || anyNA(arm_df$control_total)) {
  stop("Event/total columns contain missing/non-integer values.")
}
if (any(arm_df$dex_events < 0) || any(arm_df$dex_total <= 0) ||
    any(arm_df$control_events < 0) || any(arm_df$control_total <= 0)) {
  stop("Found negative events or non-positive totals.")
}
if (any(arm_df$dex_events > arm_df$dex_total)) {
  stop("Found dex_events > dex_total.")
}
if (any(arm_df$control_events > arm_df$control_total)) {
  stop("Found control_events > control_total.")
}
if (anyDuplicated(arm_df$comparison_id)) {
  stop("comparison_id is not unique; check trial_id + dex_arm_index.")
}


# ------------------------------------------------------------
# 2) Build arm-level long data for Model 4
# ------------------------------------------------------------

# Note:
# Each comparison_id creates exactly two rows (control and dex arm).
# Multi-arm trials are represented as separate comparisons.

control_rows <- arm_df %>%
  transmute(
    comparison_id,
    trial_id,
    arm = "control",
    treat = 0L,
    treat12 = -0.5,
    events = control_events,
    total = control_total
  )

dex_rows <- arm_df %>%
  transmute(
    comparison_id,
    trial_id,
    arm = "dex",
    treat = 1L,
    treat12 = 0.5,
    events = dex_events,
    total = dex_total
  )

model_df <- bind_rows(control_rows, dex_rows) %>%
  mutate(
    study = factor(comparison_id),
    treat = factor(treat, levels = c(0, 1))
  ) %>%
  arrange(study, treat)

arm_count_df <- model_df %>%
  count(study, name = "n_arms")

if (any(arm_count_df$n_arms != 2L)) {
  stop("Some studies do not have exactly 2 rows in model_df.")
}
if (any(model_df$events > model_df$total)) {
  stop("Internal error: events > total after long-data build.")
}


# ------------------------------------------------------------
# 3) Fit Jackson Model 4 in brms
# ------------------------------------------------------------

model_formula <- brms::bf(
  events | trials(total) ~ 0 + study + treat + (treat12 - 1 | study)
)

 default_prior(model_formula, data = model_df, family = binomial)

informative_tau_prior_OR =
  TurnerEtAlPrior(outcome = "cause-specific mortality / major morbidity event / composite (mortality or morbidity)",
                  comparator1 = "pharmacological",
                  comparator2 = "placebo / control")

informative_prior_OR_mean = informative_tau_prior_OR$parameters["tau", "mu"]
informative_prior_OR_sd = informative_tau_prior_OR$parameters["tau", "sigma"]

model_priors <- c(
  brms::prior(normal(0, 1.5), class = "b"),
  brms::prior(normal(0, 0.82), class = "b", coef = "treat1"),
  brms::prior(lognormal(-1.855, 0.87), class = "sd", group = "study", coef = "treat12")
)

model_fit <- brms::brm(
  formula = model_formula,
  data = model_df,
  family = binomial(link = "logit"),
  prior = model_priors,
  chains = chains,
  iter = iter,
  warmup = warmup,
  cores = cores,
  seed = seed,
  backend = backend,
  control = list(adapt_delta = 0.99, max_treedepth = 15),
  save_pars = brms::save_pars(all = TRUE)
)


# ------------------------------------------------------------
# 4) Extract overall OR and study-specific ORs
# ------------------------------------------------------------

draws_df <- posterior::as_draws_df(model_fit) %>%
  as.data.frame()

theta_col <- names(draws_df)[str_detect(names(draws_df), "^b_.*treat.*")]
if (length(theta_col) != 1) {
  stop(
    "Could not uniquely identify theta column in posterior draws. Candidates: ",
    paste(theta_col, collapse = ", ")
  )
}

tau_col <- names(draws_df)[str_detect(names(draws_df), "^sd_.*__treat12$")]
if (length(tau_col) != 1) {
  stop(
    "Could not uniquely identify tau column in posterior draws. Candidates: ",
    paste(tau_col, collapse = ", ")
  )
}

theta_draws <- draws_df[[theta_col]]
or_draws <- exp(theta_draws)

overall_or_summary <- tibble::tibble(
  parameter = "overall_odds_ratio",
  mean = mean(or_draws),
  median = median(or_draws),
  sd = sd(or_draws),
  q2.5 = as.numeric(quantile(or_draws, 0.025)),
  q97.5 = as.numeric(quantile(or_draws, 0.975))
)

# Study-specific OR_i = exp(theta + u_i), where u_i is the study-level
# random effect for treat12 in Jackson Model 4.
study_levels <- levels(model_df$study)

study_or_summary_list <- vector("list", length(study_levels))
study_logor_summary_list <- vector("list", length(study_levels))
study_logor_draws_list <- vector("list", length(study_levels))

for (i in seq_along(study_levels)) {
  study_id <- study_levels[[i]]

  # Use exact matching to avoid regex escaping issues in study labels.
  target_col <- paste0("r_study[", study_id, ",treat12]")
  re_col <- names(draws_df)[names(draws_df) == target_col]

  # Fallback for backend-dependent naming variants.
  if (length(re_col) == 0) {
    re_col <- names(draws_df)[
      startsWith(names(draws_df), paste0("r_study[", study_id, ",")) &
        stringr::str_detect(names(draws_df), "treat12\\]$")
    ]
  }

  if (length(re_col) != 1) {
    stop(
      "Could not uniquely identify study random effect for: ", study_id,
      ". Candidates: ", paste(re_col, collapse = ", ")
    )
  }

  study_log_or_draws <- theta_draws + draws_df[[re_col]]
  study_or_draws <- exp(study_log_or_draws)

  interval_or <- ggdist::median_hdi(study_or_draws, .width = 0.95)
  interval_logor <- ggdist::median_hdi(study_log_or_draws, .width = 0.95)

  study_or_summary_list[[i]] <- tibble::tibble(
    study = study_id,
    median = interval_or$y,
    lower_UI = interval_or$ymin,
    upper_UI = interval_or$ymax
  )

  study_logor_summary_list[[i]] <- tibble::tibble(
    study = study_id,
    median_log_or = interval_logor$y,
    lower_log_or = interval_logor$ymin,
    upper_log_or = interval_logor$ymax
  )

  study_logor_draws_list[[i]] <- tibble::tibble(
    study = study_id,
    draw_id = seq_along(study_log_or_draws),
    log_or = as.numeric(study_log_or_draws)
  )
}

study_key_df <- arm_df %>%
  distinct(comparison_id, trial_id, study_label, dex_arm_label, dex_arm_index) %>%
  rename(study = comparison_id)

study_specific_or_summary <- bind_rows(study_or_summary_list) %>%
  left_join(study_key_df, by = "study") %>%
  select(trial_id, study_label, dex_arm_label, dex_arm_index, study, median, lower_UI, upper_UI) %>%
  arrange(trial_id, dex_arm_index)

study_specific_logor_summary <- bind_rows(study_logor_summary_list) %>%
  left_join(study_key_df, by = "study") %>%
  select(trial_id, study_label, dex_arm_label, dex_arm_index, study, median_log_or, lower_log_or, upper_log_or) %>%
  arrange(trial_id, dex_arm_index)

study_logor_draws_df <- bind_rows(study_logor_draws_list) %>%
  left_join(study_key_df, by = "study")


# ------------------------------------------------------------
# 5) Crude OR by study using metafor::escalc
# ------------------------------------------------------------

# Crude (unshrunk) study-specific log-OR uses only each study's 2x2 table.
# ai/bi = dex events/non-events, ci/di = control events/non-events.
crude_or_df <- arm_df %>%
  transmute(
    trial_id,
    dex_arm_index,
    study = comparison_id,
    ai = dex_events,
    bi = dex_total - dex_events,
    ci = control_events,
    di = control_total - control_events
  )

if (any(crude_or_df$bi < 0) || any(crude_or_df$di < 0)) {
  stop("Found negative non-event counts when building 2x2 tables.")
}

# Use continuity correction only where needed (zero cells).
crude_or_df <- metafor::escalc(
  measure = "OR",
  ai = ai,
  bi = bi,
  ci = ci,
  di = di,
  add = 0.5,
  to = "only0",
  data = crude_or_df,
  append = TRUE
)

crude_or_summary <- crude_or_df %>%
  mutate(
    se = sqrt(vi),
    crude_log_or = yi,
    crude_log_or_ci_low = yi - 1.96 * se,
    crude_log_or_ci_high = yi + 1.96 * se,
    crude_or = exp(yi),
    crude_or_ci_low = exp(yi - 1.96 * se),
    crude_or_ci_high = exp(yi + 1.96 * se)
  ) %>%
  select(
    trial_id, dex_arm_index, study,
    ai, bi, ci, di,
    yi, vi, se, crude_log_or, crude_log_or_ci_low, crude_log_or_ci_high,
    crude_or, crude_or_ci_low, crude_or_ci_high
  ) %>%
  arrange(trial_id, dex_arm_index)


# ------------------------------------------------------------
# 6) bayesfoRest-style forest visualisation (copycat layout)
# ------------------------------------------------------------

overall_or_interval <- ggdist::median_hdi(or_draws, .width = 0.95)

study_layout <- study_specific_or_summary %>%
  group_by(trial_id) %>%
  mutate(n_arms_for_trial = n()) %>%
  ungroup() %>%
  mutate(
    app_study_label = if_else(
      !is.na(study_label) & trimws(study_label) != "",
      study_label,
      str_replace_all(trial_id, "_", " ")
    ),
    arm_label_clean = if_else(
      !is.na(dex_arm_label) & trimws(dex_arm_label) != "",
      dex_arm_label,
      paste0("arm ", dex_arm_index)
    ),
    plot_label = if_else(
      n_arms_for_trial == 1L,
      app_study_label,
      paste0(app_study_label, " - ", arm_label_clean)
    )
  ) %>%
  arrange(plot_label)

n_studies <- nrow(study_layout)

study_summary_for_plot <- study_layout %>%
  left_join(
    crude_or_summary %>%
      dplyr::select(study, crude_or, crude_or_ci_low, crude_or_ci_high),
    by = "study"
  ) %>%
  left_join(
    arm_df %>%
      dplyr::select(comparison_id, dex_events, dex_total, control_events, control_total),
    by = c("study" = "comparison_id")
  )

if (anyNA(study_summary_for_plot$crude_or)) {
  stop("Missing crude OR after joining study summaries for plotting.")
}

row_levels <- c("Pooled Effect", rev(study_summary_for_plot$plot_label))

shrinkage_draws_plot <- study_logor_draws_df %>%
  dplyr::filter(study %in% study_summary_for_plot$study) %>%
  left_join(
    study_summary_for_plot %>% dplyr::select(study, plot_label),
    by = "study"
  ) %>%
  mutate(
    # Guard log-scale plotting: exp() can underflow to 0 in extreme tails.
    or = pmax(exp(log_or), .Machine$double.xmin),
    row = factor(plot_label, levels = row_levels)
  )

overall_draws_plot <- tibble::tibble(
  row = factor("Pooled Effect", levels = row_levels),
  or = pmax(as.numeric(or_draws), .Machine$double.xmin)
)

observed_points_plot <- study_summary_for_plot %>%
  transmute(
    row = factor(plot_label, levels = row_levels),
    crude_or = pmax(crude_or, .Machine$double.xmin)
  )

x_lower <- min(
  study_summary_for_plot$lower_UI,
  study_summary_for_plot$crude_or_ci_low,
  overall_or_interval$ymin,
  1,
  na.rm = TRUE
)
x_upper_raw <- max(
  study_summary_for_plot$upper_UI,
  study_summary_for_plot$crude_or_ci_high,
  overall_or_interval$ymax,
  1,
  na.rm = TRUE
)

x_limits <- c(max(0.1, x_lower * 0.85), min(max(3.0, x_upper_raw * 1.15), 4.5))
if (!is.finite(x_limits[1]) || !is.finite(x_limits[2]) || x_limits[2] <= x_limits[1]) {
  x_limits <- c(0.1, 3.5)
}

x_breaks <- c(0.1, 0.3, 1, 3, 10)
x_breaks <- x_breaks[x_breaks >= x_limits[1] & x_breaks <= x_limits[2]]
if (length(x_breaks) < 2) {
  x_breaks <- sort(unique(c(signif(x_limits[1], 2), 1, signif(x_limits[2], 2))))
}

forest_center_plot <- ggplot2::ggplot(
  data = shrinkage_draws_plot,
  ggplot2::aes(y = row)
) +
  ggdist::stat_slab(
    ggplot2::aes(x = or),
    linewidth = 0.5,
    scale = 0.6,
    normalize = "panels",
    color = "purple",
    fill = NA
  ) +
  ggdist::stat_slab(
    data = overall_draws_plot,
    ggplot2::aes(x = or, y = row),
    fill = "blue",
    color = "blue",
    height = 0.9,
    normalize = "panels"
  ) +
  ggplot2::geom_point(
    data = observed_points_plot,
    ggplot2::aes(x = crude_or, y = row),
    shape = 21,
    fill = "white",
    color = "black",
    stroke = 1,
    size = 2.4
  ) +
  ggplot2::geom_vline(xintercept = 1, color = "black", linewidth = 1) +
  ggplot2::geom_vline(xintercept = overall_or_interval$y, color = "grey60", linewidth = 1) +
  ggplot2::geom_vline(
    xintercept = c(overall_or_interval$ymin, overall_or_interval$ymax),
    color = "grey60",
    linetype = 2
  ) +
  ggplot2::coord_cartesian(xlim = x_limits, clip = "off") +
  ggplot2::theme_light() +
  ggplot2::theme(
    axis.ticks.y = ggplot2::element_blank(),
    axis.text.y = ggplot2::element_blank(),
    axis.title.x = ggplot2::element_text(vjust = -0.5),
    panel.grid.major.x = ggplot2::element_blank(),
    panel.grid.minor.x = ggplot2::element_blank(),
    plot.margin = ggplot2::margin(0, 0, 0, 0),
    panel.border = ggplot2::element_blank(),
    axis.line.x.top = ggplot2::element_line(color = "grey60", linewidth = 0.75),
    axis.line.x.bottom = ggplot2::element_line(color = "black", linewidth = 0.75),
    axis.text.x.top = ggplot2::element_blank(),
    axis.ticks.x.top = ggplot2::element_blank(),
    axis.text.x.bottom = ggplot2::element_text(colour = "black")
  ) +
  ggplot2::guides(x.sec = "axis", y.sec = "axis") +
  ggplot2::annotation_custom(
    grid::textGrob(
      label = " Favours\nControl",
      x = grid::unit(1, "npc"),
      y = grid::unit(1.02, "npc"),
      just = c("right", "bottom"),
      gp = grid::gpar(col = "grey30", fontsize = 10)
    ),
    xmin = -Inf, xmax = Inf, ymin = -Inf, ymax = Inf
  ) +
  ggplot2::annotation_custom(
    grid::textGrob(
      label = " Favours\nDexmedetomidine",
      x = grid::unit(0, "npc"),
      y = grid::unit(1.02, "npc"),
      just = c("left", "bottom"),
      gp = grid::gpar(col = "grey30", fontsize = 10)
    ),
    xmin = x_limits[1], xmax = x_limits[2], ymin = -Inf, ymax = Inf
  ) +
  ggplot2::scale_x_log10(
    breaks = x_breaks,
    expand = c(0, 0)
  ) +
  ggplot2::scale_y_discrete(
    # Small padding prevents first/last slabs from being clipped.
    expand = ggplot2::expansion(add = 0.6),
    limits = row_levels
  ) +
  ggplot2::labs(x = "Odds Ratio (log scale)", y = NULL)

left_table_data <- study_summary_for_plot %>%
  transmute(
    Study = plot_label,
    Treatment = sprintf("%d/%d", dex_events, dex_total),
    Control = sprintf("%d/%d", control_events, control_total)
  ) %>%
  bind_rows(
    tibble::tibble(
      Study = "Pooled Effect",
      Treatment = sprintf("%d/%d", sum(arm_df$dex_events), sum(arm_df$dex_total)),
      Control = sprintf("%d/%d", sum(arm_df$control_events), sum(arm_df$control_total))
    )
  )

right_table_data <- study_summary_for_plot %>%
  transmute(
    Shrinkage = sprintf("%.2f [%.2f, %.2f]", median, lower_UI, upper_UI),
    Observed = sprintf("%.2f [%.2f, %.2f]", crude_or, crude_or_ci_low, crude_or_ci_high)
  ) %>%
  bind_rows(
    tibble::tibble(
      Shrinkage = sprintf("%.2f [%.2f, %.2f]", overall_or_interval$y, overall_or_interval$ymin, overall_or_interval$ymax),
      Observed = ""
    )
  )

forest_table_left <- left_table_data %>%
  gt::gt() %>%
  gt::cols_label(
    Study = "Study",
    Treatment = gt::md("Treatment<br>(Events/Total)"),
    Control = gt::md("Control<br>(Events/Total)")
  ) %>%
  gt::cols_align(align = "left") %>%
  gt::tab_style(
    style = gt::cell_text(style = "italic", weight = "bold"),
    locations = gt::cells_body(rows = Study == "Pooled Effect")
  ) %>%
  gt::tab_style(
    style = gt::cell_fill(color = "grey95"),
    locations = gt::cells_body(rows = Study == "Pooled Effect")
  ) %>%
  gt::tab_options(
    column_labels.font.weight = "bold",
    table.font.size = gt::px(13),
    data_row.padding = gt::px(2),
    table.border.top.color = "white",
    table.border.bottom.color = "white"
  ) %>%
  gt::opt_table_lines(extent = "none")

pooled_row_index <- nrow(right_table_data)

forest_table_right <- right_table_data %>%
  gt::gt() %>%
  gt::cols_label(
    Shrinkage = gt::md("Shrinkage OR<br>[95% CrI]"),
    Observed = gt::md("Observed OR<br>[95% CI]")
  ) %>%
  gt::cols_align(align = "right") %>%
  gt::tab_style(
    style = gt::cell_text(style = "italic", weight = "bold"),
    locations = gt::cells_body(rows = pooled_row_index)
  ) %>%
  gt::tab_style(
    style = gt::cell_fill(color = "grey95"),
    locations = gt::cells_body(rows = pooled_row_index)
  ) %>%
  gt::tab_options(
    column_labels.font.weight = "bold",
    table.font.size = gt::px(13),
    data_row.padding = gt::px(2),
    table.border.top.color = "white",
    table.border.bottom.color = "white"
  ) %>%
  gt::opt_table_lines(extent = "none")

logor_plot <- patchwork::wrap_table(forest_table_left, space = "fixed") +
  forest_center_plot +
  patchwork::wrap_table(forest_table_right, space = "fixed") +
  patchwork::plot_layout(
    widths = grid::unit(c(-1, 5.2, -1), c("null", "cm", "null"))
  ) +
  patchwork::plot_annotation(
    caption = "Data visualization inspired by the bayesfoRest package",
    theme = ggplot2::theme(
      plot.caption.position = "plot",
      plot.caption = ggplot2::element_text(
        hjust = 1,
        size = 9.5,
        colour = "#4D4D4D",
        face = "italic"
      )
    )
  )

# ------------------------------------------------------------
# 7) Save summaries and figure
# ------------------------------------------------------------

dir.create(output_dir, recursive = TRUE, showWarnings = FALSE)

overall_or_path <- file.path(output_dir, "model4_overall_or_summary.csv")
shrinkage_or_path <- file.path(output_dir, "model4_study_specific_or_shrinkage_hdi.csv")
shrinkage_logor_path <- file.path(output_dir, "model4_study_specific_logor_shrinkage_hdi.csv")
crude_or_path <- file.path(output_dir, "model4_study_specific_or_crude_escalc.csv")
plot_png_path <- file.path(output_dir, "model4_logor_shrinkage_vs_crude.png")
plot_pdf_path <- file.path(output_dir, "model4_logor_shrinkage_vs_crude.pdf")

readr::write_csv(overall_or_summary, overall_or_path)
readr::write_csv(study_specific_or_summary, shrinkage_or_path)
readr::write_csv(study_specific_logor_summary, shrinkage_logor_path)
readr::write_csv(crude_or_summary, crude_or_path)
ggplot2::ggsave(
  filename = plot_png_path,
  plot = logor_plot,
  width = 12,
  height = max(6.5, 1.8 + 0.34 * (n_studies + 1)),
  dpi = 350,
  bg = "white"
)
ggplot2::ggsave(
  filename = plot_pdf_path,
  plot = logor_plot,
  width = 12,
  height = max(6.5, 1.8 + 0.34 * (n_studies + 1)),
  device = grDevices::cairo_pdf,
  bg = "white"
)

cat("Saved summaries:\n")
cat(" - ", overall_or_path, "\n", sep = "")
cat(" - ", shrinkage_or_path, "\n", sep = "")
cat(" - ", shrinkage_logor_path, "\n", sep = "")
cat(" - ", crude_or_path, "\n", sep = "")
cat(" - ", plot_png_path, "\n", sep = "")
cat(" - ", plot_pdf_path, "\n", sep = "")

cat("\nOverall OR:\n")
print(overall_or_summary)

cat("\nStudy-specific shrinkage OR (first 10):\n")
print(head(study_specific_or_summary, 10))

cat("\nStudy-specific crude OR via metafor::escalc (first 10):\n")
print(head(crude_or_summary, 10))
