"""Physical, analytical and numerical checks; run with python -m unittest -v."""

from dataclasses import replace
import unittest

import numpy as np

from model import (HistoricalParameters, RSIParameters, Policy, allocate_resources,
                   consumer_resource_rhs, historical_rhs, occupied_land, rsi_rhs,
                   scenario_from_dict, simulate_history, simulate_rsi)


class HistoricalChecks(unittest.TestCase):
    def test_resident_only_analytical_equilibrium(self):
        p = HistoricalParameters()
        state = np.array([p.break_even_resource[0], p.resident_neanderthals, 0.0])
        np.testing.assert_allclose(historical_rhs(0, state, p), 0, atol=1e-13)
        modern_equilibrium = (p.resource_supply - p.resource_loss_per_year * p.break_even_resource[1]) / p.replacement_intake[1]
        np.testing.assert_allclose(historical_rhs(0, np.array([p.break_even_resource[1], 0., modern_equilibrium]), p), 0, atol=1e-13)

    def test_moderns_can_invade_resident_equilibrium(self):
        p = HistoricalParameters()
        derivative = historical_rhs(0, np.array([p.break_even_resource[0], 1.0, 0.01]), p)
        self.assertGreater(derivative[2], 0)
        self.assertLess(p.break_even_resource[1], p.break_even_resource[0])

    def test_neutral_population_ratio_is_conserved(self):
        p = replace(HistoricalParameters(), neanderthal_extra_kcal_day=0)
        result = simulate_history(p, horizon=3000, points=101)
        ratios = result.state[:, 1] / result.state[:, 2]
        np.testing.assert_allclose(ratios, p.resident_neanderthals / p.arriving_moderns, rtol=1e-8)
        self.assertTrue(result.summary["right_censored"])

    def test_zero_food_generates_starvation_and_resource_replenishment(self):
        p = HistoricalParameters()
        state = np.array([0., 1., 0.1])
        derivative = historical_rhs(0, state, p)
        np.testing.assert_allclose(derivative[1:], -(p.mortality_per_year + p.starvation_mortality_per_year) * state[1:])
        self.assertGreater(derivative[0], 0)

    def test_energy_in_resource_and_recruits_accounts_for_losses(self):
        p = HistoricalParameters()
        state = np.array([0.04, 1.0, 0.2])  # both consumers have intake above maintenance
        derivative = historical_rhs(0, state, p)
        actual = derivative[0] + p.recruitment_energy_years * derivative[1:].sum()
        expected = p.resource_supply - p.resource_loss_per_year * state[0]
        expected -= np.dot(state[1:], p.maintenance + p.recruitment_energy_years * p.mortality_per_year)
        self.assertAlmostEqual(actual, expected, places=12)

    def test_generic_model_handles_three_distinct_consumers(self):
        derivative = consumer_resource_rhs(
            np.array([0.1, 1., 0., 2.]), supply=1., resource_loss=2.,
            maintenance=np.array([1., 1.1, .9]), recruitment_cost=np.array([10., 20., 15.]),
            mortality=.025, starvation_mortality=.1,
            intake_max=np.array([2., 2.1, 1.9]), half_saturation=np.array([.01, .02, .03]),
        )
        self.assertEqual(derivative.shape, (4,))
        self.assertEqual(derivative[2], 0)  # an absent population cannot appear spontaneously

    def test_energy_rescaling_preserves_dimensionless_dynamics(self):
        p = HistoricalParameters()
        other = replace(p, modern_kcal_day=2*p.modern_kcal_day,
                        neanderthal_extra_kcal_day=2*p.neanderthal_extra_kcal_day)
        state = np.array([.03, .8, .2])
        np.testing.assert_allclose(historical_rhs(0, state, p), historical_rhs(0, state, other))

    def test_historical_parameter_validation(self):
        with self.assertRaises(ValueError):
            simulate_history(replace(HistoricalParameters(), recruitment_energy_years=100))


class ResourceAndPolicyChecks(unittest.TestCase):
    def setUp(self):
        self.p = RSIParameters()

    def test_random_feasible_states_respect_electricity_and_chips(self):
        rng = np.random.default_rng(2026)
        for _ in range(150):
            state = np.array([rng.uniform(0, 1.3), rng.uniform(0, 50),
                              rng.uniform(1, 1000), rng.uniform(.1, 5), rng.uniform(.01, 5)])
            land = occupied_land(state, self.p)
            if land > .95:
                state[[1, 3, 4]] *= .95 / land
            policy = Policy(alignment=float(rng.random()))
            f = allocate_resources(0, state, self.p, policy)
            self.assertLess(abs(f["energy_residual"]), 1e-11)
            self.assertLessEqual(f["chips_used"], f["available_fabrication"] + 1e-11)
            self.assertGreaterEqual(f["human_power"], f["human_power_reserved"] - 1e-11)
            self.assertLessEqual(f["operating_hardware"], state[1] + 1e-11)
            self.assertLessEqual(f["land_flow"], (self.p.total_land - f["occupied_land"]) / self.p.land_adjustment_years + 1e-11)

    def test_full_land_boundary_points_inward(self):
        state = self.p.initial_state()
        state[[1, 3, 4]] *= self.p.total_land / occupied_land(state, self.p)
        f = allocate_resources(0, state, self.p, Policy())
        self.assertLessEqual(f["land_flow"], 1e-10)

    def test_zero_humans_and_zero_autonomy_disable_industry(self):
        state = self.p.initial_state()
        state[0] = 0
        f = allocate_resources(0, state, self.p, Policy())
        for key in ("available_power", "available_fabrication", "operating_hardware", "build_hardware"):
            self.assertEqual(f[key], 0)
        self.assertEqual(rsi_rhs(0, state, self.p, Policy())[2], 0)

    def test_autonomy_can_support_industry_without_humans(self):
        state = self.p.initial_state()
        state[[0, 2]] = [0, 100]
        f = allocate_resources(0, state, self.p, Policy())
        self.assertGreater(f["available_power"], 0)
        self.assertGreater(f["available_fabrication"], 0)

    def test_full_alignment_protects_humans_in_expansion_stress_case(self):
        p = replace(self.p, power_expansion_per_year=.06, fabrication_expansion_per_year=.2)
        result = simulate_rsi(p, Policy(alignment=1))
        self.assertGreaterEqual(result.summary["minimum_humans"], p.initial_humans - 1e-6)
        need_land = p.human_land_per_person * np.maximum(result.state[:, 0], p.protected_humans)
        self.assertTrue(np.all(result.diagnostics["human_land"] >= need_land - 2e-6))
        self.assertLess(result.summary["maximum_energy_error"], 1e-10)

    def test_compute_cap_applies_to_physical_operating_compute_after_start(self):
        policy = Policy(compute_cap=2., cap_start_year=20.)
        result = simulate_rsi(self.p, policy, horizon=80)
        after = result.time >= policy.cap_start_year
        self.assertLessEqual(result.diagnostics["operating_hardware"][after].max(), 2. + 1e-10)
        self.assertIn(20., result.time)

    def test_successful_shutdown_stops_research_and_hardware_births(self):
        policy = Policy(shutdown_year=20.)
        result = simulate_rsi(self.p, policy, horizon=60)
        after = result.time >= 20
        self.assertTrue(np.all(result.diagnostics["operating_hardware"][after] == 0))
        self.assertTrue(np.all(result.diagnostics["build_hardware"][after] == 0))
        np.testing.assert_allclose(result.state[after, 2], result.state[after, 2][0], rtol=1e-9)
        expected = result.state[after, 1][0] * np.exp(-self.p.hardware_depreciation * (result.time[after] - 20))
        np.testing.assert_allclose(result.state[after, 1], expected, rtol=1e-5, atol=1e-9)

    def test_failed_shutdown_is_identical_to_no_intervention(self):
        baseline = simulate_rsi(self.p, horizon=40)
        failed = simulate_rsi(self.p, Policy(shutdown_year=20, shutdown_succeeds=False), horizon=40)
        np.testing.assert_allclose(failed.state, baseline.state, rtol=3e-6, atol=1e-8)

    def test_no_ai_cannot_create_hardware_or_self_improve(self):
        result = simulate_rsi(replace(self.p, initial_hardware=0), horizon=100)
        np.testing.assert_array_equal(result.state[:, 1], 0)
        np.testing.assert_array_equal(result.state[:, 2], 1)
        self.assertGreaterEqual(result.summary["minimum_humans"], 1-1e-8)

    def test_event_crossing_detects_marginal_outcome(self):
        p = replace(self.p, power_expansion_per_year=.06, fabrication_expansion_per_year=.2)
        result = simulate_rsi(p, horizon=100)
        self.assertEqual(result.summary["outcome"], "marginal_survival")
        self.assertTrue(0 < result.summary["marginal_year"] < 100)

    def test_extinction_proxy_is_recorded_without_forcing_population_to_zero(self):
        p = replace(self.p, extinction_threshold=.9, marginal_threshold=.95,
                    power_expansion_per_year=.06, fabrication_expansion_per_year=.2)
        result = simulate_rsi(p, horizon=100)
        self.assertEqual(result.summary["outcome"], "extinction_proxy")
        self.assertGreater(result.state[-1, 0], 0)

    def test_tighter_solver_settings_do_not_change_outcome(self):
        p = replace(self.p, power_expansion_per_year=.06, fabrication_expansion_per_year=.2)
        normal = simulate_rsi(p, horizon=100, points=201)
        tighter = simulate_rsi(p, horizon=100, points=201, rtol=1e-9, atol=1e-12, max_step=.1)
        self.assertEqual(normal.summary["outcome"], tighter.summary["outcome"])
        np.testing.assert_allclose(normal.state[-1], tighter.state[-1], rtol=3e-4, atol=2e-6)
        self.assertAlmostEqual(normal.summary["marginal_year"], tighter.summary["marginal_year"], places=2)

    def test_configuration_rejects_invalid_values_and_unknown_keys(self):
        for values in ({"reseach_rate": .2}, {"research_fraction": 1.1},
                       {"hardware_power": 0}, {"initial_power": float("nan")}):
            with self.assertRaises(ValueError):
                scenario_from_dict(RSIParameters, values)
        for policy in (Policy(alignment=-.1), Policy(compute_cap=-1), Policy(shutdown_year=-1)):
            with self.assertRaises(ValueError):
                policy.validate()


if __name__ == "__main__":
    unittest.main()
