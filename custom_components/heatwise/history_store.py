"""Base SQLite de l'historique des mesures (spec 010, research R1, R4).

Toutes les méthodes sont **synchrones** et ne doivent être appelées que
dans l'exécuteur (`hass.async_add_executor_job`), jamais dans la boucle
(principe V). Une connexion unique, protégée par un verrou, sert tous
les appels. Schéma : `data-model.md`.

Températures stockées en centièmes de °C, humidité en dixièmes de %,
instants en secondes epoch UTC (research R9).
"""
from __future__ import annotations

from pathlib import Path
import sqlite3
import threading

from .history import MeasurementPoint, RegulationState

SCHEMA_VERSION = 2

_SCHEMA = """
CREATE TABLE IF NOT EXISTS series (
    id INTEGER PRIMARY KEY,
    room_id TEXT NOT NULL,
    area_created_at TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS series_active
    ON series (room_id) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS measurements (
    series_id INTEGER NOT NULL,
    start INTEGER NOT NULL,
    duration INTEGER NOT NULL,
    temperature INTEGER,
    humidity INTEGER,
    PRIMARY KEY (series_id, start)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS regulation (
    series_id INTEGER NOT NULL,
    at INTEGER NOT NULL,
    target INTEGER NOT NULL,
    heating INTEGER NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    PRIMARY KEY (series_id, at)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS outdoor (
    start INTEGER PRIMARY KEY,
    duration INTEGER NOT NULL,
    temperature INTEGER
) WITHOUT ROWID;
"""


def _to_int(value: float | None, scale: int) -> int | None:
    return None if value is None else round(value * scale)


def _to_float(value: float | None, scale: int) -> float | None:
    return None if value is None else value / scale


def _state(row: tuple) -> RegulationState:
    target, heating, status, reason = row
    return RegulationState(target / 100, bool(heating), status, reason)


class HistoryStore:
    def __init__(self, path: str | Path) -> None:
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        with self._lock, self._conn:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.executescript(_SCHEMA)
            self._conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # --- Séries (research R4) ---

    def find_active_series(self, room_id: str, area_created_at: str) -> int | None:
        """Série active de cette vie de pièce, sans en créer."""
        with self._lock:
            row = self._conn.execute(
                "SELECT id FROM series WHERE room_id = ? AND area_created_at = ?"
                " AND deleted_at IS NULL",
                (room_id, area_created_at),
            ).fetchone()
        return row[0] if row else None

    def active_series(self, room_id: str, area_created_at: str, now: int) -> int:
        """Série active de la pièce ; une série d'une vie antérieure
        (autre `area_created_at`) est détachée et une nouvelle est créée."""
        with self._lock, self._conn:
            row = self._conn.execute(
                "SELECT id, area_created_at FROM series"
                " WHERE room_id = ? AND deleted_at IS NULL",
                (room_id,),
            ).fetchone()
            if row is not None:
                if row[1] == area_created_at:
                    return row[0]
                self._conn.execute(
                    "UPDATE series SET deleted_at = ? WHERE id = ?", (now, row[0])
                )
            cursor = self._conn.execute(
                "INSERT INTO series (room_id, area_created_at, created_at)"
                " VALUES (?, ?, ?)",
                (room_id, area_created_at, now),
            )
            return cursor.lastrowid

    def detach_missing(self, existing: dict[str, str], now: int) -> list[str]:
        """Détache les séries actives dont la zone n'existe plus ou a été
        recréée (`existing` : `room_id → area_created_at`). Aucune ligne
        n'est effacée (FR-006, FR-014). Retourne les `room_id` détachés."""
        with self._lock, self._conn:
            rows = self._conn.execute(
                "SELECT id, room_id, area_created_at FROM series WHERE deleted_at IS NULL"
            ).fetchall()
            detached = [
                (series_id, room_id)
                for series_id, room_id, created in rows
                if existing.get(room_id) != created
            ]
            self._conn.executemany(
                "UPDATE series SET deleted_at = ? WHERE id = ?",
                [(now, series_id) for series_id, _ in detached],
            )
        return [room_id for _, room_id in detached]

    # --- Écriture ---

    def write_measurement(self, series_id: int, point: MeasurementPoint) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT OR REPLACE INTO measurements VALUES (?, ?, ?, ?, ?)",
                (
                    series_id,
                    point.start,
                    point.duration,
                    _to_int(point.temperature, 100),
                    _to_int(point.humidity, 10),
                ),
            )

    def write_regulation(self, series_id: int, at: int, state: RegulationState) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT OR REPLACE INTO regulation VALUES (?, ?, ?, ?, ?, ?)",
                (
                    series_id,
                    at,
                    round(state.target * 100),
                    int(state.heating),
                    state.status,
                    state.reason,
                ),
            )

    def last_regulation(self, series_id: int) -> RegulationState | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT target, heating, status, reason FROM regulation"
                " WHERE series_id = ? ORDER BY at DESC LIMIT 1",
                (series_id,),
            ).fetchone()
        return _state(row) if row else None

    # --- Lecture (research R6) ---

    def max_duration(self, series_id: int, start: int, end: int) -> int | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT MAX(duration) FROM measurements"
                " WHERE series_id = ? AND start >= ? AND start < ?",
                (series_id, start, end),
            ).fetchone()
        return row[0]

    def read_measurements(
        self, series_id: int, start: int, end: int, bucket: int
    ) -> dict[int, tuple[float | None, float | None]]:
        """Cases `{début de case: (temp, hum)}` : moyenne des points qui y
        commencent, pondérée par leur durée ; `None` si aucune valeur."""
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT start - (start % :bucket) AS case_start,
                       SUM(temperature * duration) * 1.0
                         / SUM(CASE WHEN temperature IS NOT NULL THEN duration END),
                       SUM(humidity * duration) * 1.0
                         / SUM(CASE WHEN humidity IS NOT NULL THEN duration END)
                FROM measurements
                WHERE series_id = :series AND start >= :start AND start < :end
                GROUP BY case_start
                """,
                {"bucket": bucket, "series": series_id, "start": start, "end": end},
            ).fetchall()
        return {
            case_start: (_to_float(temperature, 100), _to_float(humidity, 10))
            for case_start, temperature, humidity in rows
        }

    # --- Température extérieure (spec 013, research R1) ---

    def write_outdoor(self, point: MeasurementPoint) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT OR REPLACE INTO outdoor VALUES (?, ?, ?)",
                (point.start, point.duration, _to_int(point.temperature, 100)),
            )

    def read_outdoor(self, start: int, end: int, bucket: int) -> dict[int, float | None]:
        """Cases `{début de case: temp}` : moyenne des points qui y
        commencent, pondérée par leur durée ; `None` si aucune valeur."""
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT start - (start % :bucket) AS case_start,
                       SUM(temperature * duration) * 1.0
                         / SUM(CASE WHEN temperature IS NOT NULL THEN duration END)
                FROM outdoor
                WHERE start >= :start AND start < :end
                GROUP BY case_start
                """,
                {"bucket": bucket, "start": start, "end": end},
            ).fetchall()
        return {case_start: _to_float(temperature, 100) for case_start, temperature in rows}

    def read_regulation(
        self, series_id: int, start: int, end: int
    ) -> list[tuple[int, RegulationState]]:
        """Changements de `[start, end)`, précédés du dernier état
        antérieur à `start`, ramené à `start`."""
        with self._lock:
            before = self._conn.execute(
                "SELECT target, heating, status, reason FROM regulation"
                " WHERE series_id = ? AND at < ? ORDER BY at DESC LIMIT 1",
                (series_id, start),
            ).fetchone()
            rows = self._conn.execute(
                "SELECT at, target, heating, status, reason FROM regulation"
                " WHERE series_id = ? AND at >= ? AND at < ? ORDER BY at",
                (series_id, start, end),
            ).fetchall()
        changes = [(row[0], _state(row[1:])) for row in rows]
        if before is not None and not (changes and changes[0][0] == start):
            changes.insert(0, (start, _state(before)))
        return changes
