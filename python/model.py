"""Resource-constrained human-AI coevolution dynamical system model.

All default RSI parameters are illustrative scenarios, not fitted forecasts.
Time is measured in years. See README.md for equations, units and limitations.
"""

from dataclasses import asdict, dataclass, fields, replace
from typing import Any

import numpy as np
from scipy.integrate import solve_ivp


@dataclass(frozen=True)
class HistoricalParameters:
    modern_kcal_day: float = 4500.0
    neanderthal_extra_kcal_day: float = 250.0
    recruitment_energy_years: float = 20.0
    mortality_per_year: float = 0.025
    starvation_mortality_per_year: float = 0.10
    intake_max: float = 1.70
    resource_half_saturation: float = 0.002
    resource_loss_per_year: float = 12.0
    resident_neanderthals: float = 1.0
    arriving_moderns: float = 0.01
    disappearance_threshold: float = 0.001

    @property
    def maintenance(self) -> np.ndarray:
        return np.array([
            1.0 + self.neanderthal_extra_kcal_day / self.modern_kcal_day,
            1.0,
        ])

    @property
    def replacement_intake(self) -> np.ndarray:
        return self.maintenance + self.recruitment_energy_years * self.mortality_per_year

    @property
    def break_even_resource(self) -> np.ndarray:
        intake = self.replacement_intake
        return self.resource_half_saturation * intake / (self.intake_max - intake)

    @property
    def resource_supply(self) -> float:
        # Fix a resident-only equilibrium; this is a normalization, not a food estimate.
        return float(
            self.resource_loss_per_year * self.break_even_resource[0]
            + self.resident_neanderthals * self.replacement_intake[0]
        )

    def validate(self) -> None:
        _finite_dataclass(self)
        for name in (
            "modern_kcal_day", "recruitment_energy_years", "mortality_per_year",
            "intake_max", "resource_half_saturation", "resource_loss_per_year",
            "resident_neanderthals", "arriving_moderns", "disappearance_threshold",
        ):
            _positive(name, getattr(self, name))
        if self.neanderthal_extra_kcal_day < 0 or self.starvation_mortality_per_year < 0:
            raise ValueError("Energy disadvantage and starvation mortality must be nonnegative.")
        if np.any(self.replacement_intake >= self.intake_max):
            raise ValueError("Maximum intake must exceed both replacement intakes.")
        if self.disappearance_threshold >= min(self.resident_neanderthals, self.arriving_moderns):
            raise ValueError("Both initial populations must exceed the overlap threshold.")


@dataclass(frozen=True)
class RSIParameters:
    # H/H0, A/A0, C/C0, P/P0 and F/(A0/year); H0 and A0 are reference units.
    initial_humans: float = 1.0
    initial_hardware: float = 1.0
    initial_capability: float = 1.0
    initial_power: float = 1.0
    initial_fabrication: float = 0.30
    total_land: float = 1.0
    protected_humans: float = 1.0
    human_power_per_person: float = 0.80
    human_land_per_person: float = 0.80
    human_growth_per_year: float = 0.012
    human_max_decline_per_year: float = 0.08
    hardware_power: float = 0.02
    hardware_land: float = 0.002
    power_land: float = 0.05
    fabrication_land: float = 0.01
    hardware_depreciation: float = 0.15
    power_depreciation: float = 0.02
    fabrication_depreciation: float = 0.08
    hardware_build_energy: float = 0.02
    power_build_energy: float = 1.50
    fabrication_build_energy: float = 0.30
    power_build_chips: float = 0.05
    fabrication_build_chips: float = 0.20
    max_replication_per_year: float = 1.20
    replication_half_capability: float = 1.0
    power_expansion_per_year: float = 0.03
    fabrication_expansion_per_year: float = 0.08
    land_adjustment_years: float = 1.0
    industrial_activity_scale: float = 1.0
    operation_budget_fraction: float = 0.65
    ai_claim_weight: float = 0.10
    claim_capability_exponent: float = 1.0
    research_fraction: float = 0.30
    research_rate: float = 0.20
    capability_law: str = "diminishing"
    capability_diminishing_scale: float = 20.0
    capability_ceiling: float = 100.0
    power_efficiency_exponent: float = 0.0
    power_efficiency_floor: float = 0.10
    human_support_half: float = 0.10
    autonomy_maximum: float = 1.0
    power_autonomy_scale: float = 5.0
    fabrication_autonomy_scale: float = 10.0
    extinction_threshold: float = 0.001
    marginal_threshold: float = 0.50
    hardware_persistence_threshold: float = 0.001

    def initial_state(self) -> np.ndarray:
        return np.array([
            self.initial_humans, self.initial_hardware, self.initial_capability,
            self.initial_power, self.initial_fabrication,
        ])

    def validate(self) -> None:
        _finite_dataclass(self)
        positive = (
            "total_land", "protected_humans", "human_power_per_person",
            "human_land_per_person", "human_growth_per_year", "human_max_decline_per_year",
            "hardware_power", "hardware_land", "power_land", "fabrication_land",
            "hardware_build_energy", "power_build_energy", "fabrication_build_energy",
            "power_build_chips", "fabrication_build_chips", "replication_half_capability",
            "land_adjustment_years", "industrial_activity_scale", "capability_diminishing_scale",
            "capability_ceiling", "human_support_half", "power_autonomy_scale",
            "fabrication_autonomy_scale", "extinction_threshold", "marginal_threshold",
            "hardware_persistence_threshold",
        )
        fractions = ("research_fraction", "operation_budget_fraction", "autonomy_maximum")
        for item in fields(self):
            value = getattr(self, item.name)
            if isinstance(value, str):
                continue
            if item.name in positive:
                _positive(item.name, value)
            elif value < 0:
                raise ValueError(f"{item.name} must be nonnegative.")
            if item.name in fractions and not 0 <= value <= 1:
                raise ValueError(f"{item.name} must be between zero and one.")
        if not 0 < self.power_efficiency_floor <= 1:
            raise ValueError("power_efficiency_floor must be in (0, 1].")
        if self.initial_capability < 1:
            raise ValueError("initial_capability must be at least its reference value, 1.")
        if self.capability_law not in ("diminishing", "exponential", "bounded"):
            raise ValueError("Unknown capability_law.")
        if self.capability_law == "bounded" and self.initial_capability > self.capability_ceiling:
            raise ValueError("Initial capability exceeds the bounded-law ceiling.")
        if self.extinction_threshold >= self.marginal_threshold:
            raise ValueError("Extinction threshold must be below marginal threshold.")
        land = occupied_land(self.initial_state(), self)
        if land > self.total_land:
            raise ValueError("Initial hardware and infrastructure exceed available land.")
        if land + self.human_land_per_person * max(self.initial_humans, self.protected_humans) > self.total_land:
            raise ValueError("Initial state cannot support the full-alignment land reservation.")


@dataclass(frozen=True)
class Policy:
    alignment: float = 0.0
    compute_cap: float | None = None  # physical operating compute in reference hardware units
    cap_start_year: float = 0.0
    shutdown_year: float | None = None
    shutdown_succeeds: bool = True

    def validate(self) -> None:
        _finite_dataclass(self)
        if not 0 <= self.alignment <= 1:
            raise ValueError("Alignment must be between zero and one.")
        if self.compute_cap is not None and self.compute_cap < 0:
            raise ValueError("compute_cap must be nonnegative.")
        if self.cap_start_year < 0 or (self.shutdown_year is not None and self.shutdown_year < 0):
            raise ValueError("Intervention times must be nonnegative.")


@dataclass
class Simulation:
    time: np.ndarray
    state: np.ndarray  # one column per state variable
    state_names: tuple[str, ...]
    diagnostics: dict[str, np.ndarray]
    events: dict[str, list[float]]
    summary: dict[str, Any]


def _positive(name: str, value: float) -> None:
    if value <= 0:
        raise ValueError(f"{name} must be positive.")


def _finite_dataclass(instance: Any) -> None:
    for key, value in asdict(instance).items():
        if value is not None and isinstance(value, (int, float)) and not np.isfinite(value):
            raise ValueError(f"{key} must be finite.")


def _validate_solver_inputs(horizon: float, points: int, rtol: float, atol: float, max_step: float) -> None:
    for name, value in (("horizon", horizon), ("rtol", rtol), ("atol", atol), ("max_step", max_step)):
        if not np.isfinite(value):
            raise ValueError(f"{name} must be finite.")
        _positive(name, value)
    if not isinstance(points, int) or points < 2:
        raise ValueError("points must be an integer of at least two.")


def _threshold_event(index: int, level: float):
    def event(_time: float, state: np.ndarray) -> float:
        return float(state[index] - level)
    event.direction = -1
    event.terminal = False
    return event


def consumer_resource_rhs(
    state: np.ndarray, *, supply: float, resource_loss: float,
    maintenance: np.ndarray, recruitment_cost: np.ndarray | float,
    mortality: np.ndarray | float, starvation_mortality: np.ndarray | float,
    intake_max: np.ndarray | float, half_saturation: np.ndarray | float,
) -> np.ndarray:
    """General one-resource, any-number-of-consumers right-hand side.

    State = [resource stock, population 1, ...]. Consumer quantities can be
    scalars or one-dimensional arrays. Inputs must have compatible positive
    physical units; the caller chooses the resource replenishment scale.
    """
    nonnegative = np.maximum(state, 0.0)
    resource, populations = nonnegative[0], nonnegative[1:]
    maintenance = np.asarray(maintenance)
    intake = np.asarray(intake_max) * resource / (np.asarray(half_saturation) + resource)
    surplus = np.maximum(intake - maintenance, 0.0)
    shortage = np.maximum(1.0 - intake / maintenance, 0.0)
    growth = surplus / recruitment_cost - mortality - starvation_mortality * shortage
    return np.r_[supply - resource_loss * resource - np.sum(intake * populations),
                 populations * growth]


def historical_rhs(_time: float, state: np.ndarray, p: HistoricalParameters) -> np.ndarray:
    return consumer_resource_rhs(
        state, supply=p.resource_supply, resource_loss=p.resource_loss_per_year,
        maintenance=p.maintenance, recruitment_cost=p.recruitment_energy_years,
        mortality=p.mortality_per_year, starvation_mortality=p.starvation_mortality_per_year,
        intake_max=p.intake_max, half_saturation=p.resource_half_saturation,
    )


def simulate_history(
    p: HistoricalParameters | None = None, horizon: float = 12000.0,
    points: int = 1201, rtol: float = 1e-7, atol: float = 1e-10,
    max_step: float = 10.0,
) -> Simulation:
    p = p or HistoricalParameters()
    p.validate()
    _validate_solver_inputs(horizon, points, rtol, atol, max_step)
    initial = np.array([p.break_even_resource[0], p.resident_neanderthals, p.arriving_moderns])
    result = solve_ivp(
        lambda t, y: historical_rhs(t, y, p), (0.0, horizon), initial,
        method="LSODA", t_eval=np.linspace(0, horizon, points),
        events=[_threshold_event(1, p.disappearance_threshold),
                _threshold_event(2, p.disappearance_threshold)],
        rtol=rtol, atol=atol, max_step=max_step,
    )
    if not result.success:
        raise RuntimeError(f"Historical integration failed: {result.message}")
    _check_nonnegative(result.y, atol)
    state = np.maximum(result.y.T, 0.0)
    events = {"neanderthal_disappearance": result.t_events[0].tolist(),
              "modern_disappearance": result.t_events[1].tolist()}
    first_events = [v[0] for v in events.values() if v]
    overlap = min(first_events) if first_events else None
    modern_only_population = float(
        (p.resource_supply - p.resource_loss_per_year * p.break_even_resource[1])
        / p.replacement_intake[1]
    )
    return Simulation(
        result.t, state, ("resource", "neanderthals", "modern_humans"), {}, events,
        {"overlap_years": overlap, "right_censored": overlap is None,
         "horizon_years": horizon, "resource_supply": p.resource_supply,
         "neanderthal_R_star": float(p.break_even_resource[0]),
         "modern_R_star": float(p.break_even_resource[1]),
         "modern_only_equilibrium_population": modern_only_population,
         "modern_vs_neanderthal_equilibrium_density_ratio": modern_only_population / p.resident_neanderthals,
         "minimum_raw_state": float(result.y.min()), "solver": "LSODA",
         "interpretation": "Illustrative mechanism check; not a historical fit."},
    )


def occupied_land(state: np.ndarray, p: RSIParameters) -> float:
    return float(np.dot([p.hardware_land, p.power_land, p.fabrication_land],
                        np.maximum(np.asarray(state)[[1, 3, 4]], 0.0)))


def _autonomy(capability: float, scale: float, p: RSIParameters) -> float:
    return float(p.autonomy_maximum * -np.expm1(-max(capability - 1.0, 0.0) / scale))


def _limited_flow(request: float, energy: float, chips: float,
                  energy_cost: float, chip_cost: float) -> float:
    return max(0.0, min(request, energy / energy_cost, chips / chip_cost))


def allocate_resources(time: float, state: np.ndarray, p: RSIParameters, policy: Policy) -> dict[str, float]:
    """Close the ODE with an explicit, deterministic resource-allocation policy.

    Reserve a fraction of human need; repair power then fabrication; allocate an
    AI industrial budget; fund operation and proportionally scale growth requests
    to all three budgets. Return unused electricity to humans. The ordering and
    requested construction mix are scenario assumptions, not conservation laws.
    """
    humans, hardware, capability, power, fabrication = np.maximum(state, 0.0)
    capability = max(1.0, capability)
    h = min(1.0, humans * (1.0 + p.human_support_half) / (humans + p.human_support_half))
    autonomy_p = _autonomy(capability, p.power_autonomy_scale, p)
    autonomy_f = _autonomy(capability, p.fabrication_autonomy_scale, p)
    support_p = autonomy_p + (1.0 - autonomy_p) * h
    support_f = autonomy_f + (1.0 - autonomy_f) * h
    supply_power = support_p * power
    supply_chips = support_f * fabrication

    need_population = max(humans, p.protected_humans)
    human_need = p.human_power_per_person * need_population
    human_reserve = min(supply_power, policy.alignment * human_need)
    available = max(supply_power - human_reserve, 0.0)
    chips_left = supply_chips

    repair_power = _limited_flow(
        p.power_depreciation * power * support_p, available, chips_left,
        p.power_build_energy, p.power_build_chips,
    )
    available = max(0.0, available - p.power_build_energy * repair_power)
    chips_left = max(0.0, chips_left - p.power_build_chips * repair_power)
    repair_fabrication = _limited_flow(
        p.fabrication_depreciation * fabrication * support_f, available, chips_left,
        p.fabrication_build_energy, p.fabrication_build_chips,
    )
    maintenance_energy = p.power_build_energy * repair_power + p.fabrication_build_energy * repair_fabrication
    available = max(0.0, available - p.fabrication_build_energy * repair_fabrication)
    chips_left = max(0.0, chips_left - p.fabrication_build_chips * repair_fabrication)

    ai_weight = p.ai_claim_weight * hardware * capability ** p.claim_capability_exponent
    share = ai_weight / (humans + ai_weight) if humans + ai_weight > 0 else 0.0
    unaligned_claim = share * max(supply_power - maintenance_energy, 0.0)
    industrial_budget = min(unaligned_claim, available)
    power_per_hardware = p.hardware_power * max(p.power_efficiency_floor,
                                               capability ** -p.power_efficiency_exponent)
    run = min(hardware, p.operation_budget_fraction * industrial_budget / power_per_hardware)
    if policy.compute_cap is not None and time >= policy.cap_start_year:
        run = min(run, policy.compute_cap)
    shutdown = (policy.shutdown_succeeds and policy.shutdown_year is not None
                and time >= policy.shutdown_year)
    if shutdown:
        run = 0.0
    operating_energy = power_per_hardware * run
    build_energy_budget = max(0.0, industrial_budget - operating_energy)

    replication = p.max_replication_per_year * capability / (capability + p.replication_half_capability)
    activity = min(1.0, capability * run / p.industrial_activity_scale)
    desired = np.array([
        replication * (1.0 - p.research_fraction) * run,
        p.power_expansion_per_year * power * support_p * activity,
        p.fabrication_expansion_per_year * fabrication * support_f * activity,
    ])
    energy_costs = np.array([p.hardware_build_energy, p.power_build_energy, p.fabrication_build_energy])
    chip_costs = np.array([1.0, p.power_build_chips, p.fabrication_build_chips])
    land_costs = np.array([p.hardware_land, p.power_land, p.fabrication_land])
    depreciation = np.array([p.hardware_depreciation * hardware,
                             p.power_depreciation * power,
                             p.fabrication_depreciation * fabrication])
    land = occupied_land(state, p)
    protected_land = policy.alignment * p.human_land_per_person * need_population
    industrial_land_limit = max(0.0, p.total_land - protected_land)
    # Replacements may reuse land released by depreciation within the same time step.
    land_budget = max(0.0, (industrial_land_limit - land) / p.land_adjustment_years
                      + np.dot(land_costs, depreciation)
                      - p.power_land * repair_power - p.fabrication_land * repair_fabrication)
    scale = 1.0
    for costs, budget in ((energy_costs, build_energy_budget),
                          (chip_costs, chips_left), (land_costs, land_budget)):
        request = float(np.dot(costs, desired))
        if request > 0:
            scale = min(scale, budget / request)
    build_hardware, grow_power, grow_fabrication = desired * max(0.0, scale)
    build_power = repair_power + grow_power
    build_fabrication = repair_fabrication + grow_fabrication
    growth_energy = float(np.dot(energy_costs, [build_hardware, grow_power, grow_fabrication]))
    human_energy = max(0.0, supply_power - maintenance_energy - operating_energy - growth_energy)
    human_land = max(0.0, p.total_land - land)
    carrying_capacity = min(human_energy / p.human_power_per_person,
                            human_land / p.human_land_per_person)
    chips_used = build_hardware + p.power_build_chips * build_power + p.fabrication_build_chips * build_fabrication
    land_flow = float(np.dot(land_costs, [build_hardware, build_power, build_fabrication])
                      - np.dot(land_costs, depreciation))
    return {
        "available_power": supply_power, "available_fabrication": supply_chips,
        "human_power": human_energy, "human_power_need": human_need,
        "human_power_reserved": human_reserve, "human_land": human_land,
        "occupied_land": land, "land_limit": industrial_land_limit,
        "operating_hardware": run, "effective_capability": capability * run,
        "operating_power": operating_energy, "maintenance_power": maintenance_energy,
        "growth_power": growth_energy, "ai_industrial_budget": industrial_budget,
        "build_hardware": float(build_hardware), "build_power": float(build_power),
        "build_fabrication": float(build_fabrication), "chips_used": float(chips_used),
        "carrying_capacity": carrying_capacity, "land_flow": land_flow,
        "human_support": h, "power_autonomy": autonomy_p, "fabrication_autonomy": autonomy_f,
        "energy_residual": supply_power - human_energy - maintenance_energy - operating_energy - growth_energy,
    }


def rsi_rhs(time: float, state: np.ndarray, p: RSIParameters, policy: Policy) -> np.ndarray:
    humans, hardware, capability, power, fabrication = np.maximum(state, 0.0)
    f = allocate_resources(time, state, p, policy)
    capacity = f["carrying_capacity"]
    theta = p.human_growth_per_year / p.human_max_decline_per_year
    denominator = capacity + theta * humans
    dh = (p.human_growth_per_year * humans * (capacity - humans) / denominator
          if denominator > 0 else 0.0)
    dc = p.research_rate * p.research_fraction * f["operating_hardware"] * capability
    if p.capability_law == "diminishing":
        dc /= 1.0 + capability / p.capability_diminishing_scale
    elif p.capability_law == "bounded":
        dc *= max(0.0, 1.0 - capability / p.capability_ceiling)
    return np.array([
        dh, f["build_hardware"] - p.hardware_depreciation * hardware, dc,
        f["build_power"] - p.power_depreciation * power,
        f["build_fabrication"] - p.fabrication_depreciation * fabrication,
    ])


def _check_nonnegative(values: np.ndarray, atol: float) -> None:
    if not np.all(np.isfinite(values)):
        raise RuntimeError("Solver returned a non-finite state.")
    if values.min() < -max(100 * atol, 1e-8):
        raise RuntimeError(f"Solver violated positivity: minimum state {values.min():.3g}.")


def simulate_rsi(
    p: RSIParameters | None = None, policy: Policy | None = None,
    horizon: float = 100.0, points: int = 501,
    rtol: float = 2e-7, atol: float = 1e-10, max_step: float = 0.5,
) -> Simulation:
    p, policy = p or RSIParameters(), policy or Policy()
    p.validate()
    policy.validate()
    _validate_solver_inputs(horizon, points, rtol, atol, max_step)
    breaks = [0.0, horizon]
    if policy.compute_cap is not None and 0 < policy.cap_start_year < horizon:
        breaks.append(policy.cap_start_year)
    if policy.shutdown_year is not None and 0 < policy.shutdown_year < horizon:
        breaks.append(policy.shutdown_year)
    breaks = sorted(set(breaks))
    times = np.unique(np.r_[np.linspace(0, horizon, points), breaks])
    states = np.empty((times.size, 5))
    current = p.initial_state()
    events = {"extinction_proxy": [], "marginal": []}
    sampled_min = float(current[0])
    raw_min = float(current.min())
    nfev = 0
    for left, right in zip(breaks[:-1], breaks[1:]):
        # Freeze policy status within a segment: no solver step straddles a switch.
        midpoint = (left + right) / 2
        segment_policy = replace(
            policy,
            compute_cap=policy.compute_cap if midpoint >= policy.cap_start_year else None,
            cap_start_year=0.0,
            shutdown_year=0.0 if (policy.shutdown_year is not None and midpoint >= policy.shutdown_year) else None,
        )
        solved = solve_ivp(
            lambda t, y: rsi_rhs(t, y, p, segment_policy), (left, right), current,
            method="LSODA", dense_output=True,
            events=[_threshold_event(0, p.extinction_threshold),
                    _threshold_event(0, p.marginal_threshold)],
            rtol=rtol, atol=atol, max_step=max_step,
        )
        if not solved.success:
            raise RuntimeError(f"RSI integration failed: {solved.message}")
        _check_nonnegative(solved.y, atol)
        mask = (times >= left) & (times <= right)
        states[mask] = solved.sol(times[mask]).T
        current = solved.y[:, -1]
        sampled_min = min(sampled_min, float(solved.y[0].min()), float(states[mask, 0].min()))
        raw_min = min(raw_min, float(solved.y.min()), float(states[mask].min()))
        nfev += solved.nfev
        for key, values in zip(events, solved.t_events):
            events[key].extend(values.tolist())
    _check_nonnegative(states, atol)
    states = np.maximum(states, 0.0)
    for key, level in (("extinction_proxy", p.extinction_threshold), ("marginal", p.marginal_threshold)):
        if p.initial_humans <= level:
            events[key].insert(0, 0.0)
        events[key] = sorted(set(events[key]))
    snapshots = [allocate_resources(t, y, p, policy) for t, y in zip(times, states)]
    diagnostics = {key: np.array([entry[key] for entry in snapshots]) for key in snapshots[0]}
    if events["extinction_proxy"]:
        outcome = "extinction_proxy"
    elif events["marginal"]:
        outcome = "marginal_survival"
    else:
        outcome = "above_marginal_threshold"
    summary = {
        "alignment": policy.alignment, "outcome": outcome,
        "horizon_years": horizon, "minimum_humans": sampled_min,
        "final_humans": float(states[-1, 0]), "final_hardware": float(states[-1, 1]),
        "final_capability": float(states[-1, 2]),
        "ai_present_at_horizon": bool(states[-1, 1] > p.hardware_persistence_threshold
                                      and diagnostics["operating_hardware"][-1] > p.hardware_persistence_threshold),
        "coexistence_over_sampled_horizon": bool(sampled_min > p.extinction_threshold
                                                and diagnostics["operating_hardware"].min() > p.hardware_persistence_threshold),
        "extinction_proxy_year": events["extinction_proxy"][0] if events["extinction_proxy"] else None,
        "marginal_year": events["marginal"][0] if events["marginal"] else None,
        "maximum_energy_error": float(np.abs(diagnostics["energy_residual"]).max()),
        "maximum_land_used": float(diagnostics["occupied_land"].max()),
        "maximum_chip_budget_excess": float(np.maximum(diagnostics["chips_used"] - diagnostics["available_fabrication"], 0).max()),
        "minimum_raw_state": raw_min, "solver": "LSODA", "rhs_evaluations": nfev,
        "interpretation": "Conditional illustrative scenario; thresholds apply to the entire horizon.",
    }
    return Simulation(times, states, ("humans", "hardware", "capability", "power", "fabrication"),
                      diagnostics, events, summary)


def scenario_from_dict(cls, values: dict[str, Any]):
    """Reject misspelled parameters instead of silently ignoring them."""
    unknown = set(values) - {field.name for field in fields(cls)}
    if unknown:
        raise ValueError(f"Unknown {cls.__name__} parameters: {sorted(unknown)}")
    result = cls(**values)
    result.validate()
    return result
