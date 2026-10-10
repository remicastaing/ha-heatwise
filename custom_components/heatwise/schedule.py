"""Logique pure de la programmation Heatwise (spec 005).

Ce module ne dépend d'aucune API Home Assistant : il manipule des
structures Python simples (voir `data-model.md`) et n'effectue aucune
E/S. La persistance vit dans `schedules_store.py`, le transport
websocket dans `websocket_api.py`.

Représentation (cf. `research.md` R2) :

- une **journée** (`Day`) est une liste de plages triée et normalisée
  (sans chevauchement, pas deux plages adjacentes à la même
  température) ;
- une **plage** (`Slot`) est `{"start": int, "end": int,
  "temperature": float}`, en minutes depuis minuit
  (`0 ≤ start < end ≤ 1440`, multiples de 15) ;
- une **semaine type** (`Week`) est une liste de 7 journées indexées
  comme `datetime.weekday()` (0 = lundi … 6 = dimanche) ; l'ordre
  d'affichage samedi → vendredi (spec, FR-002) est une affaire de
  présentation, jamais de stockage (R2) ;
- une **programmation de pièce** (`RoomSchedule`) est
  `{"parity": bool, "weeks": {...}, "vacation": Week}`, avec
  `weeks = {"all": Week}` sans parité ou `{"even": Week, "odd": Week}`
  avec parité (R4).
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

MIN_TEMPERATURE = 7.0
MAX_TEMPERATURE = 25.0
TEMPERATURE_STEP = 0.5
SLOT_STEP = 15
DAY_MINUTES = 1440
DAYS_PER_WEEK = 7
DEFAULT_TEMPERATURE = 16.0

# Programmes adressables d'une pièce (R4). `all` n'existe que sans
# parité ; `even`/`odd` que sous option de parité active.
PROGRAMS = ("all", "even", "odd", "vacation")

# Copies autorisées entre programmes (R4, spec FR-020/FR-023) :
# paire ↔ impaire, et n'importe quel programme habituel → vacances.
_ALLOWED_COPIES = {
    ("even", "odd"),
    ("odd", "even"),
    ("all", "vacation"),
    ("even", "vacation"),
    ("odd", "vacation"),
}


class InvalidSlotError(Exception):
    """Jour ou horaires de plage invalides (FR-007)."""


class InvalidTemperatureError(Exception):
    """Température hors bornes ou pas incorrect (FR-008)."""


class ProgramNotFoundError(Exception):
    """Programme non disponible pour cette pièce (`all` avec parité
    active, `even`/`odd` sans parité, ou nom inconnu)."""


class KeepRequiredError(Exception):
    """Désactivation de la parité sans préciser quelle semaine garder
    (FR-018)."""


class InvalidCopyError(Exception):
    """Copie de programme non autorisée (FR-020, FR-023)."""


def validate_temperature(temperature: float) -> None:
    """Lève `InvalidTemperatureError` si `temperature` n'est pas dans
    [7, 25] par pas de 0,5 (FR-008)."""
    if temperature < MIN_TEMPERATURE or temperature > MAX_TEMPERATURE:
        raise InvalidTemperatureError(
            f"Température hors bornes : {temperature} "
            f"(entre {MIN_TEMPERATURE} et {MAX_TEMPERATURE})"
        )
    steps = (temperature - MIN_TEMPERATURE) / TEMPERATURE_STEP
    if abs(steps - round(steps)) > 1e-9:
        raise InvalidTemperatureError(
            f"Température {temperature} non alignée au pas de "
            f"{TEMPERATURE_STEP}"
        )


def validate_slot(day: int, start: int, end: int) -> None:
    """Lève `InvalidSlotError` si le jour ou les horaires ne respectent
    pas FR-007 (jour 0-6, quart d'heure, 0 ≤ start < end ≤ 1440)."""
    if not 0 <= day < DAYS_PER_WEEK:
        raise InvalidSlotError(f"Jour hors bornes : {day}")
    if start % SLOT_STEP or end % SLOT_STEP:
        raise InvalidSlotError(
            f"Horaires non alignés au quart d'heure : start={start}, end={end}"
        )
    if not (0 <= start < end <= DAY_MINUTES):
        raise InvalidSlotError(
            f"Plage invalide : start={start}, end={end} (0 ≤ start < end ≤ {DAY_MINUTES})"
        )


def empty_week() -> list[list[dict[str, Any]]]:
    """Sept journées vides et **distinctes** (pas la même liste
    répétée sept fois, sous peine d'aliasing)."""
    return [[] for _ in range(DAYS_PER_WEEK)]


def empty_room_schedule() -> dict[str, Any]:
    """Programmation vide d'une pièce (pièce nouvelle ou absente du
    Store) : pas de parité, semaine unique vide, vacances vides."""
    return {
        "parity": False,
        "weeks": {"all": empty_week()},
        "vacation": empty_week(),
    }


def get_week(room_schedule: dict[str, Any], program: str) -> list[list[dict[str, Any]]]:
    """Renvoie la semaine du programme demandé.

    Lève `ProgramNotFoundError` si `program` n'est pas dans `PROGRAMS`,
    ou si `even`/`odd` est demandé sans parité active, ou `all` avec
    parité active.
    """
    if program not in PROGRAMS:
        raise ProgramNotFoundError(program)
    if program == "vacation":
        return room_schedule["vacation"]
    weeks = room_schedule["weeks"]
    if program not in weeks:
        raise ProgramNotFoundError(program)
    return weeks[program]


def normalize_day(day: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Trie une journée par `start` et fusionne les plages adjacentes
    de même température (FR-007)."""
    ordered = sorted(day, key=lambda slot: slot["start"])
    merged: list[dict[str, Any]] = []
    for slot in ordered:
        if merged and merged[-1]["end"] == slot["start"] and merged[-1]["temperature"] == slot["temperature"]:
            merged[-1] = {**merged[-1], "end": slot["end"]}
        else:
            merged.append(dict(slot))
    return merged


def paint(
    day: list[dict[str, Any]], start: int, end: int, temperature: float | None
) -> list[dict[str, Any]]:
    """Applique une température (ou l'efface si `None`) sur
    `[start, end[`, en coupant les plages existantes qui débordent, puis
    normalise (R3). Ne modifie pas `day` : renvoie une nouvelle liste.

    Valide `start`/`end` (via l'appelant, `apply_operations`, qui
    connaît le jour) et `temperature` si elle n'est pas `None`.
    """
    if temperature is not None:
        validate_temperature(temperature)

    remaining: list[dict[str, Any]] = []
    for slot in day:
        # Portion avant l'intervalle peint.
        if slot["start"] < start:
            remaining.append(
                {
                    "start": slot["start"],
                    "end": min(slot["end"], start),
                    "temperature": slot["temperature"],
                }
            )
        # Portion après l'intervalle peint.
        if slot["end"] > end:
            remaining.append(
                {
                    "start": max(slot["start"], end),
                    "end": slot["end"],
                    "temperature": slot["temperature"],
                }
            )
    if temperature is not None:
        remaining.append({"start": start, "end": end, "temperature": temperature})
    return normalize_day(remaining)


def apply_operations(
    room_schedule: dict[str, Any],
    program: str,
    operations: list[dict[str, Any]],
) -> dict[str, Any]:
    """Applique atomiquement une liste d'opérations « peindre » sur le
    programme demandé et renvoie une **copie** de `room_schedule`
    modifiée (FR-004 à FR-007).

    Chaque opération est `{"day": int, "start": int, "end": int,
    "temperature": float | None}`. Toute opération invalide (jour,
    horaires, température, programme) lève l'exception adéquate avant
    que quoi que ce soit ne soit renvoyé — `room_schedule` n'est jamais
    modifié en place.
    """
    result = copy_room_schedule(room_schedule)
    week = get_week(result, program)
    for operation in operations:
        day = operation["day"]
        start = operation["start"]
        end = operation["end"]
        temperature = operation["temperature"]
        validate_slot(day, start, end)
        week[day] = paint(week[day], start, end, temperature)
    return result


def copy_days(
    room_schedule: dict[str, Any],
    program: str,
    source_day: int,
    target_days: list[int],
) -> dict[str, Any]:
    """Copie la journée `source_day` vers chaque jour de `target_days`
    (`source_day` ignoré s'il y figure) — FR-015, FR-016. Remplace
    entièrement les jours cibles ; les autres jours sont inchangés."""
    if not 0 <= source_day < DAYS_PER_WEEK:
        raise InvalidSlotError(f"Jour hors bornes : {source_day}")
    for day in target_days:
        if not 0 <= day < DAYS_PER_WEEK:
            raise InvalidSlotError(f"Jour hors bornes : {day}")

    result = copy_room_schedule(room_schedule)
    week = get_week(result, program)
    source = [dict(slot) for slot in week[source_day]]
    for day in target_days:
        if day == source_day:
            continue
        week[day] = [dict(slot) for slot in source]
    return result


def set_parity(
    room_schedule: dict[str, Any], enabled: bool, keep: str | None = None
) -> dict[str, Any]:
    """Active ou désactive l'option semaines paires/impaires d'une pièce
    (FR-017, FR-018).

    À l'activation, `even` et `odd` sont initialisées avec des copies
    indépendantes de `all`. À la désactivation, `keep` (`"even"` ou
    `"odd"`) est obligatoire (sinon `KeepRequiredError`) : la semaine
    conservée devient `all`. Demander l'état déjà en vigueur est sans
    effet. `vacation` n'est jamais modifiée.
    """
    result = copy_room_schedule(room_schedule)
    if enabled == result["parity"]:
        return result

    if enabled:
        base = result["weeks"]["all"]
        result["weeks"] = {
            "even": [[dict(slot) for slot in day] for day in base],
            "odd": [[dict(slot) for slot in day] for day in base],
        }
    else:
        if keep not in ("even", "odd"):
            raise KeepRequiredError()
        kept = result["weeks"][keep]
        result["weeks"] = {"all": [[dict(slot) for slot in day] for day in kept]}

    result["parity"] = enabled
    return result


def copy_program(room_schedule: dict[str, Any], source: str, target: str) -> dict[str, Any]:
    """Copie intégralement `source` vers `target` (FR-020, FR-023).

    Copies autorisées : `even → odd`, `odd → even`, et
    `all | even | odd → vacation`. Toute autre combinaison lève
    `InvalidCopyError`. `source`/`target` inexistants pour la pièce
    lèvent `ProgramNotFoundError` (ex. `even` sans parité)."""
    if (source, target) not in _ALLOWED_COPIES:
        raise InvalidCopyError(f"Copie non autorisée : {source} → {target}")

    result = copy_room_schedule(room_schedule)
    source_week = get_week(result, source)
    copied = [[dict(slot) for slot in day] for day in source_week]
    if target == "vacation":
        result["vacation"] = copied
    else:
        # target in {"even", "odd"} : n'existe que si la parité est
        # active (sinon get_week aurait déjà levé sur `source`, mais on
        # revérifie explicitement la cible).
        if target not in result["weeks"]:
            raise ProgramNotFoundError(target)
        result["weeks"][target] = copied
    return result


def reference_monday(day: date) -> date:
    """Lundi de référence d'une semaine samedi → vendredi (R5) : le
    lundi qui suit un samedi ou un dimanche, ou le lundi de la semaine
    en cours du lundi au vendredi. C'est ce lundi qui détermine la
    parité de toute la semaine (clarification du 2026-09-18)."""
    weekday = day.weekday()  # 0 = lundi … 5 = samedi, 6 = dimanche
    if weekday >= 5:  # samedi ou dimanche
        return day + timedelta(days=7 - weekday)
    return day - timedelta(days=weekday)


def active_program(
    room_schedule: dict[str, Any], vacation_mode: bool, now: datetime
) -> tuple[str, int]:
    """Détermine le programme applicable à l'instant `now` (heure
    locale) et le numéro de semaine ISO de son lundi de référence (R5,
    R6).

    Ordre : `vacation` si `vacation_mode` ; sinon `all` sans parité ;
    sinon `even`/`odd` selon la parité ISO du lundi de référence de la
    semaine samedi → vendredi contenant `now`.
    """
    monday = reference_monday(now.date())
    week_number = monday.isocalendar().week
    if vacation_mode:
        return "vacation", week_number
    if not room_schedule["parity"]:
        return "all", week_number
    return ("even" if week_number % 2 == 0 else "odd"), week_number


def current_target(
    room_schedule: dict[str, Any], settings: dict[str, Any], now: datetime
) -> float:
    """Consigne courante d'une pièce (FR-027) : température de la plage
    de la journée applicable qui contient l'instant `now` (heure murale
    locale), sinon la consigne hors plage (`settings`)."""
    program, _ = active_program(room_schedule, settings["vacation_mode"], now)
    week = get_week(room_schedule, program)
    day = week[now.weekday()]
    minute = now.hour * 60 + now.minute
    for slot in day:
        if slot["start"] <= minute < slot["end"]:
            return slot["temperature"]
    return settings["default_temperature"]


def copy_room_schedule(room_schedule: dict[str, Any]) -> dict[str, Any]:
    """Copie profonde et indépendante d'une programmation de pièce
    (parité, semaines habituelles, vacances) — utilisée en interne par
    ce module avant toute modification, et par
    `heatwise/copy_room_schedule` pour dupliquer une pièce vers d'autres
    (FR-025, FR-026)."""
    return {
        "parity": room_schedule["parity"],
        "weeks": {
            name: [[dict(slot) for slot in day] for day in week]
            for name, week in room_schedule["weeks"].items()
        },
        "vacation": [[dict(slot) for slot in day] for day in room_schedule["vacation"]],
    }
