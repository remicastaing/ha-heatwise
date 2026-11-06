"""Logique pure de l'historique des mesures (spec 010).

Aucun import Home Assistant : échantillonnage, grille des intervalles,
état de régulation et mise en grille de lecture sont testables sans HA
(cf. `data-model.md`, research R2, R3, R5, R6). Le contrôleur HA vit
dans `history_recorder.py`, le stockage dans `history_store.py`.

Les instants sont des secondes epoch UTC entières.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class MeasurementPoint:
    """Un point d'historique : moyenne des échantillons valables de
    `[start, start + duration)` ; `None` = aucun échantillon valable."""

    start: int
    duration: int
    temperature: float | None
    humidity: float | None


@dataclass(frozen=True)
class RegulationState:
    """Consigne appliquée, chauffe et état de régulation d'une pièce ;
    une nouvelle ligne n'est écrite que si l'état diffère (research R5)."""

    target: float
    heating: bool
    status: str
    reason: str | None


class Sampler:
    """Accumule les échantillons à la minute d'un intervalle (research R2).

    `add` reçoit `None` pour une mesure absente, indisponible, non
    numérique ou périmée : elle n'entre pas dans la moyenne. `has_sensor`
    indique qu'un capteur était associé à la pièce lors de l'échantillon ;
    un intervalle sans aucun capteur associé ne produit pas de point.
    """

    def __init__(self, start: int) -> None:
        self.start = start
        self._sums = [0.0, 0.0]
        self._counts = [0, 0]
        self._has_sensor = False

    def add(
        self, temperature: float | None, humidity: float | None, *, has_sensor: bool
    ) -> None:
        self._has_sensor = self._has_sensor or has_sensor
        for index, value in enumerate((temperature, humidity)):
            if value is not None:
                self._sums[index] += value
                self._counts[index] += 1

    def close(self, end: int) -> MeasurementPoint | None:
        if not self._has_sensor or end <= self.start:
            return None
        temperature, humidity = (
            self._sums[i] / self._counts[i] if self._counts[i] else None
            for i in range(2)
        )
        return MeasurementPoint(self.start, end - self.start, temperature, humidity)


def is_boundary(ts: int, minutes: int) -> bool:
    """Vrai si `ts` est une borne de la grille UTC de pas `minutes`."""
    return ts % (minutes * 60) == 0


def interval_bounds(ts: int, minutes: int) -> tuple[int, int]:
    """Intervalle `[début, fin)` de la grille de pas `minutes` contenant `ts`."""
    step = minutes * 60
    start = ts - ts % step
    return start, start + step


def bucket_seconds(period_step: int, max_duration: int | None) -> int:
    """Taille d'une case de lecture : au moins le pas de la période, et
    au moins la plus grande durée de point de la plage, pour qu'aucune
    case ne soit vide à tort quand la fréquence a changé (research R6)."""
    bucket = max(period_step, max_duration or 0)
    return -(-bucket // 60) * 60


def grid_bounds(now: int, period_seconds: int, bucket: int) -> tuple[int, int]:
    """Bornes alignées de la grille de lecture : fin = case qui contient
    `now` (incluse), début = fin − période, arrondi à la case."""
    end = now - now % bucket + bucket
    start = end - period_seconds
    start -= start % bucket
    return start, end


def fill_grid(
    buckets: dict[int, tuple[float | None, float | None]],
    start: int,
    end: int,
    bucket: int,
) -> tuple[list[float | None], list[float | None]]:
    """Place les cases agrégées `{début de case: (temp, hum)}` dans une
    grille régulière ; une case absente vaut `None` (trou, FR-013b)."""
    temperatures: list[float | None] = []
    humidities: list[float | None] = []
    for case_start in range(start, end, bucket):
        temperature, humidity = buckets.get(case_start, (None, None))
        temperatures.append(None if temperature is None else round(temperature, 2))
        humidities.append(None if humidity is None else round(humidity, 1))
    return temperatures, humidities
