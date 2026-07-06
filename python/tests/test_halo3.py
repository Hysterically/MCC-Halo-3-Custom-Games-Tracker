"""The tracker-DB adapter: category rules, CSR mapping, ladder replay."""

import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from trueskill2.halo3 import (
    StoredMatch, StoredPlayer, board_category, categorize, category_matches,
    compute_ladder, csr_from_skill, halo3_params, load_matches, to_ts2_match,
)


def sp(xuid, team, standing, kills=10, deaths=10):
    return StoredPlayer(xuid=xuid, gamertag=f"gt-{xuid}", team_id=team,
                        standing=standing, score=0, kills=kills, deaths=deaths, assists=0)


def sm(mid, players, teams_enabled=True, played_at=0, duration=600, excluded=False):
    return StoredMatch(match_id=mid, game_type="Slayer", teams_enabled=teams_enabled,
                       played_at=played_at, winning_team_id=None,
                       duration_seconds=duration, excluded=excluded, players=players)


def four_v_four(mid, winners, losers, played_at=0):
    players = [sp(x, 0, 1) for x in winners] + [sp(x, 1, 2) for x in losers]
    return sm(mid, players, played_at=played_at)


class TestCategory(unittest.TestCase):
    def test_4v4(self):
        m = four_v_four("m1", ["a", "b", "c", "d"], ["e", "f", "g", "h"])
        self.assertEqual(categorize(m), "4v4")
        self.assertEqual(board_category(m), "4v4")

    def test_2v2(self):
        m = sm("m", [sp("a", 0, 1), sp("b", 0, 1), sp("c", 1, 2), sp("d", 1, 2)])
        self.assertEqual(categorize(m), "2v2")

    def test_ffa(self):
        m = sm("m", [sp(x, -1, i + 1) for i, x in enumerate("abcd")], teams_enabled=False)
        self.assertEqual(categorize(m), "ffa")

    def test_uneven_is_other(self):
        m = sm("m", [sp("a", 0, 1), sp("b", 0, 1), sp("c", 1, 2)])
        self.assertEqual(categorize(m), "other")

    def test_short_and_excluded_forced_other(self):
        m = four_v_four("m", list("abcd"), list("efgh"))
        m.duration_seconds = 30
        self.assertEqual(board_category(m), "other")
        m.duration_seconds = 600
        m.excluded = True
        self.assertEqual(board_category(m), "other")


class TestCsr(unittest.TestCase):
    def test_matches_ts_mapping(self):
        # Same spot-checks as src/csr.ts: value = round(63 * skill), floored at 0.
        self.assertEqual(csr_from_skill(0.0), (0, "Bronze 1"))
        self.assertEqual(csr_from_skill(-5.0), (0, "Bronze 1"))
        value, tier = csr_from_skill(22.6)
        self.assertEqual(value, round(22.6 * 63))
        self.assertEqual(tier, "Diamond 5")
        value, tier = csr_from_skill(25.0)
        self.assertEqual((value, tier), (1575, "Onyx"))


class TestConversion(unittest.TestCase):
    def test_team_match(self):
        m = four_v_four("m1", list("abcd"), list("efgh"))
        conv = to_ts2_match(m, "4v4")
        self.assertEqual(len(conv.teams), 2)
        self.assertAlmostEqual(conv.length, 10.0)
        ranks = sorted(t.rank for t in conv.teams)
        self.assertEqual(ranks, [1, 2])

    def test_ffa_each_player_own_team(self):
        m = sm("m", [sp(x, -1, i + 1) for i, x in enumerate("abcd")], teams_enabled=False)
        conv = to_ts2_match(m, "ffa")
        self.assertEqual(len(conv.teams), 4)
        self.assertEqual([t.rank for t in conv.teams], [1, 2, 3, 4])

    def test_counts_flow_through(self):
        m = four_v_four("m1", list("abcd"), list("efgh"))
        conv = to_ts2_match(m, "4v4")
        self.assertEqual(conv.teams[0].players[0].kills, 10.0)
        conv2 = to_ts2_match(m, "4v4", use_counts=False)
        self.assertIsNone(conv2.teams[0].players[0].kills)


class TestLadderReplay(unittest.TestCase):
    def _history(self):
        # Team A (a,b,c,d) beats team B (e,f,g,h) three times, loses once.
        out = []
        for i in range(3):
            out.append(four_v_four(f"m{i}", list("abcd"), list("efgh"), played_at=i * 3_600_000))
        out.append(four_v_four("m3", list("efgh"), list("abcd"), played_at=4 * 3_600_000))
        return out

    def test_online_ladder(self):
        rows = compute_ladder(self._history(), "4v4")
        self.assertEqual(len(rows), 8)
        by_id = {r.xuid: r for r in rows}
        self.assertGreater(by_id["a"].mu, by_id["e"].mu)
        self.assertEqual(by_id["a"].games, 4)
        # Sorted best-first by conservative skill.
        skills = [r.mu - 3 * r.sigma for r in rows]
        self.assertEqual(skills, sorted(skills, reverse=True))

    def test_batch_ladder(self):
        rows = compute_ladder(self._history(), "4v4", use_batch=True)
        by_id = {r.xuid: r for r in rows}
        self.assertGreater(by_id["a"].mu, by_id["e"].mu)

    def test_sigma_floor_applied(self):
        rows = compute_ladder(self._history(), "4v4")
        for r in rows:
            self.assertGreaterEqual(r.sigma, 1.0 - 1e-9)


class TestSqliteRoundtrip(unittest.TestCase):
    def test_load_matches(self):
        with tempfile.TemporaryDirectory() as td:
            db = str(Path(td) / "tracker.db")
            con = sqlite3.connect(db)
            con.executescript(
                """
                CREATE TABLE matches (
                  match_id TEXT PRIMARY KEY, game_type TEXT NOT NULL,
                  teams_enabled INTEGER NOT NULL, played_at INTEGER NOT NULL,
                  winning_team_id INTEGER, recorded_at INTEGER NOT NULL,
                  map_name TEXT, map_variant TEXT, duration_seconds INTEGER,
                  results_msg_id TEXT, results_fmt INTEGER,
                  excluded INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE match_players (
                  match_id TEXT NOT NULL, xuid TEXT NOT NULL, gamertag TEXT NOT NULL,
                  team_id INTEGER NOT NULL, standing INTEGER NOT NULL,
                  score INTEGER NOT NULL, kills INTEGER NOT NULL,
                  deaths INTEGER NOT NULL, assists INTEGER NOT NULL,
                  PRIMARY KEY (match_id, xuid));
                """
            )
            con.execute(
                "INSERT INTO matches VALUES ('m1','Slayer',1,1000,0,1000,'Pit',NULL,600,NULL,NULL,0)"
            )
            for xuid, team, standing in (("a", 0, 1), ("b", 0, 1), ("c", 1, 2), ("d", 1, 2)):
                con.execute(
                    "INSERT INTO match_players VALUES ('m1',?,?,?,?,0,10,8,2)",
                    (xuid, f"gt-{xuid}", team, standing),
                )
            con.commit()
            con.close()

            stored = load_matches(db)
            self.assertEqual(len(stored), 1)
            self.assertEqual(stored[0].match_id, "m1")
            self.assertEqual(len(stored[0].players), 4)
            self.assertEqual(categorize(stored[0]), "2v2")
            matches = category_matches(stored, "2v2")
            self.assertEqual(len(matches), 1)


if __name__ == "__main__":
    unittest.main()
