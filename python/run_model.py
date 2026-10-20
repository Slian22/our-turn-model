"""Run the models, export auditable data, and draw the figures."""

import argparse
import csv
from dataclasses import asdict, replace
import json
from pathlib import Path
import platform
import textwrap

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import LogNorm
import numpy as np
import scipy
from scipy.stats import qmc, spearmanr

from model import (HistoricalParameters, Policy, RSIParameters, Simulation,
                   scenario_from_dict, simulate_history, simulate_rsi)


HERE = Path(__file__).resolve().parent
COLORS = ["#cc4f37", "#df9b34", "#6b77b1", "#238a83", "#204d75"]
OUTCOMES = ("above_marginal_threshold", "marginal_survival", "extinction_proxy")
OUTCOME_COLORS = ("#238a83", "#df9b34", "#cc4f37")
STRESS_OVERRIDES = {"power_expansion_per_year": 0.06, "fabrication_expansion_per_year": 0.20}
UNCERTAINTY = {
    "research_rate": {"lower": 0.05, "upper": 0.40, "scale": "log"},
    "max_replication_per_year": {"lower": 0.4, "upper": 2.0, "scale": "log"},
    "power_expansion_per_year": {"lower": 0.015, "upper": 0.10, "scale": "linear"},
    "fabrication_expansion_per_year": {"lower": 0.03, "upper": 0.40, "scale": "linear"},
    "hardware_power": {"lower": 0.01, "upper": 0.06, "scale": "log"},
    "hardware_land": {"lower": 0.001, "upper": 0.006, "scale": "linear"},
    "power_land": {"lower": 0.03, "upper": 0.08, "scale": "linear"},
    "power_autonomy_scale": {"lower": 2.0, "upper": 30.0, "scale": "log"},
    "fabrication_autonomy_scale": {"lower": 3.0, "upper": 50.0, "scale": "log"},
    "ai_claim_weight": {"lower": 0.03, "upper": 0.30, "scale": "log"},
    "human_max_decline_per_year": {"lower": 0.04, "upper": 0.12, "scale": "linear"},
}


def default_config() -> dict:
    return {
        "historical": asdict(HistoricalParameters()), "rsi": asdict(RSIParameters()),
        "stress_overrides": STRESS_OVERRIDES,
        "analysis": {"horizon_years": 100.0, "historical_horizon_years": 12000.0,
                     "seed": 2026, "ensemble_samples": 48,
                     "shutdown_failure_probability": 0.10, "compute_cap": 2.0},
        "uncertainty": UNCERTAINTY,
    }


def save_json(path: Path, content) -> None:
    path.write_text(json.dumps(content, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def save_rows(path: Path, rows: list[dict]) -> None:
    if not rows:
        return
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def save_simulation(folder: Path, name: str, simulation: Simulation) -> None:
    columns = {"year": simulation.time}
    columns.update({key: simulation.state[:, i] for i, key in enumerate(simulation.state_names)})
    columns.update(simulation.diagnostics)
    np.savetxt(folder / f"{name}.csv", np.column_stack(list(columns.values())),
               delimiter=",", header=",".join(columns), comments="", fmt="%.12g")
    save_json(folder / f"{name}_summary.json", {**simulation.summary, "events": simulation.events})


def finish(fig, path: Path, footnote: str = "Illustrative scenarios; no forecast probabilities are implied.") -> None:
    # Reserve real layout space: footer text must never overlap axis labels.
    engine = fig.get_layout_engine()
    if engine is not None:
        engine.set(rect=(0, 0.10, 1, 0.90))
    wrapped = textwrap.fill(footnote, width=max(55, int(fig.get_figwidth() * 15)))
    fig.text(0.015, 0.012, wrapped, fontsize=8, color="#566273", va="bottom")
    fig.savefig(path, dpi=170, bbox_inches="tight", facecolor="white")
    plt.close(fig)


def history_analysis(p: HistoricalParameters, horizon: float, folder: Path, quick: bool) -> dict:
    historical = simulate_history(p, horizon=horizon)
    save_simulation(folder, "historical", historical)
    fig, axes = plt.subplots(1, 2, figsize=(12, 4.5), layout="constrained")
    time, states = historical.time, historical.state
    ax = axes[0]
    ax.axvspan(2600, 5400, color="#dce9ed", label="Europe-wide comparison interval")
    ax.plot(time, states[:, 1], color=COLORS[0], label="Neanderthals")
    ax.plot(time, states[:, 2], color=COLORS[3], label="Modern humans")
    ax.axhline(p.disappearance_threshold, color="#677483", ls=":", label="Disappearance proxy")
    if historical.summary["overlap_years"] is not None:
        ax.axvline(historical.summary["overlap_years"], color="#566273", ls="--", lw=1)
    ax.set(yscale="log", ylim=(p.disappearance_threshold / 3, max(2, states[:, 1:].max() * 1.2)),
           xlabel="Years after modelled arrival", ylabel="Population / reference resident population",
           title="Historical mechanism check")
    ax.legend(fontsize=8)
    axes[1].plot(time, states[:, 0], color=COLORS[4], label="Accessible food stock")
    for value, color, label in zip(p.break_even_resource, [COLORS[0], COLORS[3]], ["Neanderthal R*", "Modern-human R*"]):
        axes[1].axhline(value, color=color, ls="--", label=label)
    axes[1].set(xlabel="Years after modelled arrival", ylabel="Food stock / reference annual maintenance energy",
                title="The shared resource mediates competition")
    axes[1].legend(fontsize=8)
    finish(fig, folder / "historical.png", "Europe interval from the supplied brief (Higham et al., 2014). Parameters are illustrative, not fitted.")

    rows = []
    extra_values = np.linspace(100, 350, 6 if quick else 11)
    recruitment_values = [10.0, 20.0, 25.0]
    for cost in recruitment_values:
        for extra in extra_values:
            candidate = replace(p, neanderthal_extra_kcal_day=float(extra), recruitment_energy_years=cost)
            try:
                result = simulate_history(candidate, horizon=horizon, points=301)
                rows.append({"extra_kcal_day": float(extra), "recruitment_energy_years": cost,
                             "overlap_years": result.summary["overlap_years"],
                             "right_censored": result.summary["right_censored"], "error": ""})
            except (ValueError, RuntimeError) as error:
                rows.append({"extra_kcal_day": float(extra), "recruitment_energy_years": cost,
                             "overlap_years": None, "right_censored": None, "error": str(error)})
    save_rows(folder / "historical_sensitivity.csv", rows)
    fig, ax = plt.subplots(figsize=(8, 4.5), layout="constrained")
    ax.axhspan(2600, 5400, color="#dce9ed", label="Europe-wide comparison interval")
    for color, cost in zip(COLORS, recruitment_values):
        selected = [row for row in rows if row["recruitment_energy_years"] == cost]
        ax.plot([r["extra_kcal_day"] for r in selected],
                [r["overlap_years"] if r["overlap_years"] is not None else np.nan for r in selected],
                marker="o", color=color, label=f"Recruitment energy: {cost:g} reference food-years")
    ax.set(xlabel="Extra Neanderthal adult maintenance energy (kcal/day)",
           ylabel="Overlap duration (years)", title="Energy data do not identify the demographic timescale")
    ax.legend(fontsize=8)
    finish(fig, folder / "historical_sensitivity.png", "Unobserved demographic costs strongly affect duration. Missing points are censored or invalid; see CSV.")
    return historical.summary


def population_figures(base: RSIParameters, stress: RSIParameters, horizon: float, folder: Path) -> list[dict]:
    alignments = [0.0, 0.25, 0.5, 0.75, 1.0]
    simulations = [simulate_rsi(stress, Policy(alignment=x), horizon=horizon) for x in alignments]
    default = simulate_rsi(base, Policy(alignment=0), horizon=horizon)
    no_ai = simulate_rsi(replace(base, initial_hardware=0), Policy(alignment=0), horizon=horizon)
    save_simulation(folder, "rsi_default_unaligned", default)
    save_simulation(folder, "rsi_no_ai", no_ai)
    for value, simulation in zip(alignments, simulations):
        save_simulation(folder, f"rsi_stress_alignment_{value:.2f}", simulation)
    fig, axes = plt.subplots(2, 2, figsize=(12, 8), layout="constrained")
    for alignment, color, sim in zip(alignments, COLORS, simulations):
        axes[0, 0].plot(sim.time, sim.state[:, 0], color=color, label=f"Alignment {alignment:g}")
        axes[0, 1].plot(sim.time, sim.state[:, 1], color=color)
    axes[0, 0].plot(default.time, default.state[:, 0], color="#647080", ls="--", label="Default growth, alignment 0")
    axes[0, 0].plot(no_ai.time, no_ai.state[:, 0], color="#1f2937", ls=":", label="No AI, default infrastructure")
    axes[0, 0].axhline(stress.marginal_threshold, color="#687586", ls="-.", lw=1)
    axes[0, 0].set(title="Human population", ylabel="H / initial human population", xlabel="Years")
    axes[0, 0].legend(fontsize=7.5, ncols=2)
    axes[0, 1].set(title="AI hardware population", ylabel="Installed hardware / reference hardware", xlabel="Years", yscale="log")
    sample = simulations[0]
    d = sample.diagnostics
    axes[1, 0].stackplot(sample.time, d["human_power"], d["operating_power"],
                         d["maintenance_power"], d["growth_power"],
                         labels=["Human use", "AI operation", "Shared repairs", "Industrial construction"],
                         colors=[COLORS[3], COLORS[0], COLORS[1], COLORS[2]])
    axes[1, 0].plot(sample.time, d["available_power"], color="#20334a", lw=1, label="Usable supply")
    axes[1, 0].set(title="Electricity accounting: stress case, alignment 0", ylabel="Power / initial generation", xlabel="Years")
    axes[1, 0].legend(fontsize=7.5)
    axes[1, 1].stackplot(sample.time, d["human_land"], stress.hardware_land * sample.state[:, 1],
                         stress.power_land * sample.state[:, 3], stress.fabrication_land * sample.state[:, 4],
                         colors=[COLORS[3], COLORS[0], COLORS[1], COLORS[2]],
                         labels=["Available to humans", "AI hardware", "Power infrastructure", "Fabrication"])
    axes[1, 1].set(title="Land accounting: stress case, alignment 0", ylabel="Fraction of modelled land", xlabel="Years", ylim=(0, stress.total_land))
    axes[1, 1].legend(fontsize=7.5)
    fig.suptitle("Human–RSI competition under explicit resource budgets", fontsize=15)
    finish(fig, folder / "rsi_scenarios.png", "Stress scenario changes requested power expansion to 6%/year and fabrication expansion to 20%/year; all defaults are illustrative.")

    fig, axes = plt.subplots(1, 3, figsize=(13, 4.2), layout="constrained")
    for alignment, color, sim in zip(alignments, COLORS, simulations):
        for ax, values in zip(axes, [sim.state[:, 2], sim.state[:, 3], sim.state[:, 4]]):
            ax.plot(sim.time, values, color=color, label=f"Alignment {alignment:g}")
    for ax, title, ylabel in zip(axes, ["Capability per hardware unit", "Installed power generation", "Fabrication capacity"],
                                 ["C / reference capability", "P / initial power", "Hardware reference units / year"]):
        ax.set(title=title, xlabel="Years", ylabel=ylabel, yscale="log")
    axes[0].legend(fontsize=8)
    finish(fig, folder / "rsi_infrastructure.png")
    summaries = [{"scenario": "default", **default.summary}, {"scenario": "no_ai", **no_ai.summary}]
    summaries += [{"scenario": "expansion_stress", **sim.summary} for sim in simulations]
    save_rows(folder / "scenario_summaries.csv", summaries)
    return summaries


def threshold_analysis(p: RSIParameters, horizon: float, folder: Path, quick: bool) -> list[dict]:
    alignments = np.linspace(0, 1, 11 if quick else 21)
    rates = np.linspace(0.02, 0.40, 7 if quick else 13)
    minima = np.empty((len(rates), len(alignments)))
    rows, thresholds = [], []
    for i, rate in enumerate(rates):
        safe = []
        for j, alignment in enumerate(alignments):
            result = simulate_rsi(replace(p, fabrication_expansion_per_year=float(rate)),
                                  Policy(alignment=float(alignment)), horizon=horizon, points=201)
            minima[i, j] = result.summary["minimum_humans"]
            is_safe = result.summary["outcome"] == OUTCOMES[0]
            safe.append(is_safe)
            rows.append({"fabrication_expansion_per_year": float(rate), "alignment": float(alignment),
                         "minimum_humans": minima[i, j], "outcome": result.summary["outcome"]})
        safe_values = [float(x) for x, okay in zip(alignments, safe) if okay]
        monotone = all(not safe[j] or safe[j + 1] for j in range(len(safe) - 1))
        thresholds.append({"fabrication_expansion_per_year": float(rate),
                           "lowest_safe_grid_alignment": min(safe_values) if safe_values else None,
                           "safe_grid_values": json.dumps(safe_values),
                           "safety_monotone_on_grid": monotone})
    save_rows(folder / "alignment_sensitivity.csv", rows)
    save_rows(folder / "alignment_thresholds.csv", thresholds)
    fig, ax = plt.subplots(figsize=(9, 5.5), layout="constrained")
    image = ax.pcolormesh(alignments, rates, minima, shading="nearest", cmap="viridis",
                         norm=LogNorm(vmin=max(1e-4, min(p.extinction_threshold, minima.min())), vmax=max(1, minima.max())))
    if minima.min() < p.marginal_threshold < minima.max():
        contour = ax.contour(alignments, rates, minima, levels=[p.marginal_threshold], colors="white", linewidths=1.5)
        ax.clabel(contour, fmt={p.marginal_threshold: "Marginal threshold"}, fontsize=8)
    if minima.min() < p.extinction_threshold < minima.max():
        ax.contour(alignments, rates, minima, levels=[p.extinction_threshold], colors="#ef7c65", linewidths=1.5)
    fig.colorbar(image, ax=ax, label="Minimum human population / initial population (log scale)")
    ax.set(xlabel="Alignment", ylabel="Requested fabrication expansion rate (per year)",
           title="Where do human outcomes cross the chosen thresholds?")
    finish(fig, folder / "alignment_sensitivity.png", "Power expansion held at the stress-scenario value. Reported alignment thresholds have finite grid resolution.")
    return thresholds


def timing_analysis(p: RSIParameters, horizon: float, failure: float, cap: float, folder: Path) -> None:
    baseline = simulate_rsi(p, Policy(alignment=0), horizon=horizon, points=201)
    rows = []
    times = np.linspace(0, horizon, 11)
    for time in times:
        capped = simulate_rsi(p, Policy(compute_cap=cap, cap_start_year=float(time)), horizon=horizon, points=201)
        success = simulate_rsi(p, Policy(shutdown_year=float(time)), horizon=horizon, points=201)
        failure_case = baseline  # A failed shutdown has no effect in this explicitly stated branch model.
        risk = lambda result: float(result.summary["outcome"] != OUTCOMES[0])
        rows.append({
            "intervention_year": float(time), "compute_cap": cap,
            "cap_minimum_humans": capped.summary["minimum_humans"], "cap_outcome": capped.summary["outcome"],
            "shutdown_success_minimum_humans": success.summary["minimum_humans"],
            "shutdown_success_outcome": success.summary["outcome"],
            "shutdown_failure_probability_assumed": failure,
            "shutdown_branch_weighted_minimum_humans": ((1-failure) * success.summary["minimum_humans"] + failure * failure_case.summary["minimum_humans"]),
            "shutdown_probability_of_threshold_failure": (1-failure) * risk(success) + failure * risk(failure_case),
            "cap_threshold_failure": risk(capped),
        })
    save_rows(folder / "intervention_timing.csv", rows)
    fig, axes = plt.subplots(1, 2, figsize=(12, 4.8), layout="constrained")
    axes[0].plot(times, [r["cap_minimum_humans"] for r in rows], marker="o", color=COLORS[4], label="Compute cap")
    axes[0].plot(times, [r["shutdown_success_minimum_humans"] for r in rows], marker="s", color=COLORS[3], label="Successful shutdown")
    axes[0].plot(times, [r["shutdown_branch_weighted_minimum_humans"] for r in rows], ls="--", color=COLORS[1], label="Shutdown: branch-weighted minimum")
    axes[0].axhline(p.marginal_threshold, color="#677483", ls=":", label="Marginal threshold")
    axes[0].set(xlabel="Intervention year", ylabel="Minimum H / initial H over entire horizon", title="Population outcomes depend on intervention timing")
    axes[0].legend(fontsize=8)
    axes[1].step(times, [r["cap_threshold_failure"] for r in rows], where="mid", color=COLORS[4], label="Compute cap: deterministic threshold crossing")
    axes[1].plot(times, [r["shutdown_probability_of_threshold_failure"] for r in rows], marker="o", color=COLORS[1], label="Shutdown: assumed failure branches")
    axes[1].set(xlabel="Intervention year", ylabel="Probability of crossing a population threshold",
                ylim=(-0.03, 1.03), title=f"Shutdown failure probability assumed: {failure:.0%}")
    axes[1].legend(fontsize=8)
    finish(fig, folder / "intervention_timing.png", f"Stress scenario, alignment 0. Operating compute cap: {cap:g} reference hardware units. Successful shutdown is permanent; installed hardware depreciates.")


def ensemble_analysis(p: RSIParameters, uncertainty: dict, samples: int, seed: int, horizon: float, folder: Path) -> dict:
    if samples < 1:
        raise ValueError("Ensemble sample count must be positive.")
    keys = list(uncertainty)
    known = set(asdict(p))
    if not keys or set(keys) - known:
        raise ValueError("Uncertainty specification has empty or unknown parameters.")
    draws = qmc.LatinHypercube(d=len(keys), seed=seed).random(samples)
    parameter_sets = []
    for draw in draws:
        parameters = {}
        for key, value in zip(keys, draw):
            spec = uncertainty[key]
            lo, hi, scale = spec["lower"], spec["upper"], spec["scale"]
            if not np.isfinite([lo, hi]).all() or lo >= hi or scale not in ("log", "linear"):
                raise ValueError(f"Invalid uncertainty bounds for {key}.")
            if scale == "log" and lo <= 0:
                raise ValueError(f"Log uncertainty range must be positive: {key}.")
            parameters[key] = float(np.exp(np.log(lo) + value * np.log(hi / lo)) if scale == "log" else lo + value * (hi-lo))
        parameter_sets.append(parameters)
    rows, errors = [], []
    laws = ("diminishing", "exponential", "bounded")
    for index, parameters in enumerate(parameter_sets):
        for law in laws:
            candidate = replace(p, **parameters, capability_law=law)
            for alignment in (0.0, 0.5, 1.0):
                try:
                    result = simulate_rsi(candidate, Policy(alignment=alignment), horizon=horizon, points=151)
                    rows.append({"sample": index, "capability_law": law, "alignment": alignment,
                                 **parameters, "minimum_humans": result.summary["minimum_humans"],
                                 "outcome": result.summary["outcome"], "error": ""})
                except (ValueError, RuntimeError, FloatingPointError) as error:
                    row = {"sample": index, "capability_law": law, "alignment": alignment,
                           **parameters, "minimum_humans": None, "outcome": "unresolved", "error": str(error)}
                    rows.append(row)
                    errors.append(row)
        if (index + 1) % 12 == 0:
            print(f"  Scenario ensemble: {index+1}/{samples} parameter sets", flush=True)
    save_rows(folder / "ensemble_samples.csv", rows)
    frequencies = []
    for law in (*laws, "equal_weight_law_mixture"):
        for alignment in (0.0, 0.5, 1.0):
            group = [r for r in rows if r["alignment"] == alignment and (law == "equal_weight_law_mixture" or r["capability_law"] == law)]
            for outcome in (*OUTCOMES, "unresolved"):
                count = sum(r["outcome"] == outcome for r in group)
                frequencies.append({"capability_law": law, "alignment": alignment, "outcome": outcome,
                                    "count": count, "total": len(group), "scenario_fraction": count / len(group)})
    save_rows(folder / "ensemble_frequencies.csv", frequencies)
    fig, axes = plt.subplots(1, 3, figsize=(13, 4.5), layout="constrained", sharey=True)
    for ax, law in zip(axes, laws):
        bottom = np.zeros(3)
        for outcome, color in zip((*OUTCOMES, "unresolved"), (*OUTCOME_COLORS, "#677483")):
            vals = [next(r["scenario_fraction"] for r in frequencies if r["capability_law"] == law and r["alignment"] == a and r["outcome"] == outcome) for a in (0.0, 0.5, 1.0)]
            ax.bar([0, 1, 2], vals, bottom=bottom, color=color, label=outcome.replace("_", " "))
            bottom += vals
        ax.set(xticks=[0, 1, 2], xticklabels=["0", "0.5", "1"], xlabel="Alignment", title=f"Capability law: {law}", ylim=(0, 1))
    axes[0].set_ylabel("Fraction of declared parameter scenarios")
    axes[-1].legend(fontsize=7.5, loc="upper right")
    finish(fig, folder / "ensemble_outcomes.png", f"{samples} paired parameter sets per capability law. Frequencies depend on the declared ranges and sampling measure; they are not forecast probabilities.")
    selected = [r for r in rows if r["alignment"] == 0 and r["capability_law"] == "diminishing" and not r["error"]]
    ranks = []
    for key in keys:
        x, y = [r[key] for r in selected], [r["minimum_humans"] for r in selected]
        rho = float(spearmanr(x, y).statistic) if len(selected) > 2 and np.ptp(x) > 0 and np.ptp(y) > 0 else None
        ranks.append({"parameter": key, "spearman_rho_with_minimum_humans": rho,
                      "scope": "alignment 0; diminishing law; conditional scenario ensemble"})
    ranks.sort(key=lambda r: abs(r["spearman_rho_with_minimum_humans"] or 0), reverse=True)
    save_rows(folder / "sensitivity_rankings.csv", ranks)
    return {"parameter_sets": samples, "capability_laws": list(laws), "unresolved_runs": len(errors),
            "total_runs": len(rows), "interpretation": "Scenario frequencies, not empirically calibrated probabilities."}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=HERE / "parameters.json")
    parser.add_argument("--out", type=Path, default=HERE / "results")
    parser.add_argument("--quick", action="store_true", help="Use a smaller grid and 12 ensemble parameter sets.")
    parser.add_argument("--ensemble-samples", type=int)
    parser.add_argument("--write-default-config", type=Path)
    args = parser.parse_args()
    if args.write_default_config:
        args.write_default_config.parent.mkdir(parents=True, exist_ok=True)
        save_json(args.write_default_config, default_config())
        print(f"Wrote {args.write_default_config}")
        return
    config = json.loads(args.config.read_text())
    if set(config) - set(default_config()):
        raise ValueError("Unknown top-level configuration sections.")
    if set(config.get("analysis", {})) - set(default_config()["analysis"]):
        raise ValueError("Unknown analysis settings.")
    historical = scenario_from_dict(HistoricalParameters, config.get("historical", {}))
    base = scenario_from_dict(RSIParameters, config.get("rsi", {}))
    stress = scenario_from_dict(RSIParameters, {**asdict(base), **config.get("stress_overrides", STRESS_OVERRIDES)})
    settings = {**default_config()["analysis"], **config.get("analysis", {})}
    horizon = float(settings["horizon_years"])
    failure = float(settings["shutdown_failure_probability"])
    if not 0 <= failure <= 1:
        raise ValueError("Shutdown failure probability must be in [0, 1].")
    samples = args.ensemble_samples if args.ensemble_samples is not None else (12 if args.quick else int(settings["ensemble_samples"]))
    args.out.mkdir(parents=True, exist_ok=True)
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "axes.spines.top": False,
                         "axes.spines.right": False, "axes.grid": True, "grid.alpha": 0.15})
    effective_config = {"historical": asdict(historical), "rsi": asdict(base),
                        "stress_overrides": config.get("stress_overrides", STRESS_OVERRIDES),
                        "analysis": {**settings, "ensemble_samples": samples},
                        "uncertainty": config.get("uncertainty", UNCERTAINTY)}
    save_json(args.out / "configuration_used.json", effective_config)
    print("Running the historical mechanism check...", flush=True)
    history = history_analysis(historical, settings["historical_horizon_years"], args.out, args.quick)
    print("Running human–RSI scenarios and resource accounting...", flush=True)
    scenarios = population_figures(base, stress, horizon, args.out)
    print("Scanning alignment and construction sensitivity...", flush=True)
    thresholds = threshold_analysis(stress, horizon, args.out, args.quick)
    print("Comparing compute caps and shutdown timing...", flush=True)
    timing_analysis(stress, horizon, failure, float(settings["compute_cap"]), args.out)
    print("Running the paired uncertainty and capability-law ensemble...", flush=True)
    ensemble = ensemble_analysis(base, effective_config["uncertainty"], samples,
                                 int(settings["seed"]), horizon, args.out)
    summary = {"historical": history, "scenarios": scenarios, "ensemble": ensemble,
               "alignment_grid_monotone_all_rows": all(r["safety_monotone_on_grid"] for r in thresholds),
               "versions": {"python": platform.python_version(), "numpy": np.__version__,
                            "scipy": scipy.__version__, "matplotlib": matplotlib.__version__},
               "quick_mode": args.quick,
               "caution": "Default parameters, uncertainty distributions and allocation rules are illustrative. Do not interpret as a forecast."}
    save_json(args.out / "summary.json", summary)
    print(f"Finished. Results: {args.out.resolve()}", flush=True)


if __name__ == "__main__":
    main()
