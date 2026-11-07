"""Mise en forme des réponses de l'API LLM Heatwise (spec 012).

Fonctions pures, sans dépendance à Home Assistant : conversions
d'heures, résolution des noms de pièce, vues compactes destinées à un
assistant IA (research R6, R7 ; data-model « Vues assistant »).
"""
from __future__ import annotations

from datetime import datetime, timedelta, tzinfo
import re
import unicodedata
from typing import Any

_HHMM = re.compile(r"^(\d{1,2}):(\d{2})$")


class ToolError(Exception):
    """Erreur renvoyée à l'assistant comme un résultat lisible (FR-020) :
    un code court et une phrase en français, plus des champs facultatifs
    (par exemple la liste des pièces existantes)."""

    def __init__(self, code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.extra = extra

    def as_dict(self) -> dict[str, Any]:
        return tool_error(self.code, self.message, **self.extra)


def tool_error(code: str, message: str, **extra: Any) -> dict[str, Any]:
    return {"error": code, "message": message, **extra}


# --- Heures ---


def minutes_to_hhmm(minutes: int) -> str:
    """Minutes depuis minuit → « HH:MM » (1440 → « 24:00 »)."""
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def hhmm_to_minutes(text: str) -> int:
    """« H:MM » / « HH:MM » → minutes depuis minuit, de 0 à 1440
    (« 24:00 » accepté). Lève `ValueError` sinon. Le pas d'un quart
    d'heure n'est pas vérifié ici (`schedule.validate_slot`)."""
    match = _HHMM.match(text.strip()) if isinstance(text, str) else None
    if match is None:
        raise ValueError(f"Heure invalide : {text!r} (format attendu HH:MM)")
    hours, minutes = int(match.group(1)), int(match.group(2))
    if minutes > 59 or hours > 24 or (hours == 24 and minutes):
        raise ValueError(f"Heure invalide : {text!r}")
    return hours * 60 + minutes


def next_occurrence(now: datetime, minutes: int) -> datetime:
    """Prochaine occurrence, strictement après `now`, de l'heure murale
    `minutes` (depuis minuit, 1440 = minuit suivant) dans le fuseau de
    `now` : « 08:30 » demandé à 22:00 tombe le lendemain."""
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    candidate = midnight + timedelta(minutes=minutes)
    if candidate <= now:
        candidate += timedelta(days=1)
    return candidate


def local_minute(value: str | datetime | None, tz: tzinfo | None = None) -> str | None:
    """Instant ISO → « YYYY-MM-DDTHH:MM » en heure locale (`tz` si
    fourni, sinon le décalage de la valeur), sans secondes ni décalage."""
    if value is None:
        return None
    moment = datetime.fromisoformat(value) if isinstance(value, str) else value
    if tz is not None:
        moment = moment.astimezone(tz)
    return moment.strftime("%Y-%m-%dT%H:%M")


# --- Pièces ---


def normalize_name(name: str) -> str:
    """Casse, accents et espaces ignorés (« Salle  d'Été » → « salle d'ete »)."""
    decomposed = unicodedata.normalize("NFKD", name)
    without_accents = "".join(c for c in decomposed if not unicodedata.combining(c))
    return " ".join(without_accents.casefold().split())


def _room_refs(rooms: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"room_id": r["room_id"], "name": r["name"]} for r in rooms]


def resolve_room(rooms: list[dict[str, Any]], query: str) -> dict[str, Any]:
    """Pièce désignée par identifiant ou par nom (research R6) :
    identifiant exact, puis nom normalisé exact, puis unique pièce dont
    le nom normalisé contient la saisie. Lève `ToolError`
    (`room_not_found` / `room_ambiguous`) avec la liste des candidates."""
    for room in rooms:
        if room["room_id"] == query:
            return room
    wanted = normalize_name(query or "")
    if wanted:
        exact = [r for r in rooms if normalize_name(r["name"]) == wanted]
        if len(exact) == 1:
            return exact[0]
        partial = exact or [r for r in rooms if wanted in normalize_name(r["name"])]
        if len(partial) == 1:
            return partial[0]
        if len(partial) > 1:
            raise ToolError(
                "room_ambiguous",
                f"Plusieurs pièces correspondent à « {query} ».",
                rooms=_room_refs(partial),
            )
    raise ToolError(
        "room_not_found",
        f"Aucune pièce ne correspond à « {query} ».",
        rooms=_room_refs(rooms),
    )


def _number(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _rounded(value: Any, digits: int) -> float | int | None:
    number = _number(value)
    if number is None:
        return None
    return round(number) if digits == 0 else round(number, digits)


def _sensor(room: dict[str, Any]) -> tuple[str, float | None]:
    """État de la sonde et température mesurée (data-model, R7)."""
    if not room["has_sensor"]:
        return "none", None
    if room["sensor_missing"]:
        return "missing", None
    current = room["current_temperature"]
    if current in (None, "unknown"):
        return "unavailable", None
    temperature = _rounded(current, 1)
    if temperature is None:
        return "invalid", None
    return ("stale" if room["sensor_stale"] else "ok"), temperature


def room_summary(room: dict[str, Any], *, humidity: Any) -> dict[str, Any]:
    """Vue compacte d'une pièce assemblée par `rooms` (FR-005).
    `humidity` = état brut du capteur d'humidité de la pièce."""
    sensor, temperature = _sensor(room)
    regulation = room.get("regulation") or {}
    summary: dict[str, Any] = {
        "room_id": room["room_id"],
        "name": room["name"],
        "temperature_c": temperature,
        "humidity_pct": _rounded(humidity, 0),
        "sensor": sensor,
        "target_c": room["target_temperature"],
        "heating": bool(room["heating"]),
        "status": regulation.get("status") if room["has_radiator"] else "no_radiator",
    }
    if "target_source" in regulation:
        summary["target_source"] = regulation["target_source"]
    return summary


def room_detail(
    room: dict[str, Any],
    *,
    humidity: Any,
    battery: Any,
    radiators: list[dict[str, Any]],
    tz: tzinfo | None = None,
) -> dict[str, Any]:
    """Vue détaillée d'une pièce (FR-006) : vue compacte, régulation,
    pile de la sonde et radiateurs (sans identifiant technique, FR-019)."""
    regulation = room.get("regulation") or {}
    return {
        **room_summary(room, humidity=humidity),
        "reason": regulation.get("reason"),
        "suspended_until": local_minute(regulation.get("suspended_until"), tz),
        "battery_pct": _rounded(battery, 0),
        "radiators": [{"name": r["name"], "heating": bool(r["heating"])} for r in radiators],
    }


# --- Planning (US4, US6) ---

DAY_NAMES = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
_DAY_ALIASES = {
    **{name: index for index, name in enumerate(DAY_NAMES)},
    **{
        name: index
        for index, name in enumerate(
            ("lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche")
        )
    },
}


def parse_days(days: list[Any]) -> list[int]:
    """Jours 0–6 (0 = lundi) ou noms anglais / français, sans doublon,
    triés. Lève `ToolError("invalid_day")`."""
    result: set[int] = set()
    for day in days:
        if isinstance(day, bool):
            index = None
        elif isinstance(day, int):
            index = day if 0 <= day < len(DAY_NAMES) else None
        elif isinstance(day, str):
            index = _DAY_ALIASES.get(normalize_name(day))
        else:
            index = None
        if index is None:
            raise ToolError(
                "invalid_day",
                f"Jour invalide : {day!r} (0 à 6, ou monday…sunday, lundi…dimanche).",
            )
        result.add(index)
    if not result:
        raise ToolError("invalid_day", "Indiquer au moins un jour.")
    return sorted(result)


def format_day(slots: list[dict[str, Any]]) -> list[str]:
    """Créneaux d'une journée en heures lisibles : « 06:30–08:00 20.0 »."""
    return [
        f"{minutes_to_hhmm(s['start'])}–{minutes_to_hhmm(s['end'])} {s['temperature']:.1f}"
        for s in slots
    ]


# --- Historique (US6, research R8) ---


def _mean(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def _downsample(series: list[Any], group: int, digits: int) -> list[Any]:
    points = []
    for i in range(0, len(series), group):
        mean = _mean([v for v in series[i : i + group] if v is not None])
        points.append(_rounded(mean, digits))
    return points


def _stats(series: list[Any], digits: int) -> dict[str, Any] | None:
    values = [v for v in series if v is not None]
    if not values:
        return None
    return {
        "min": _rounded(min(values), digits),
        "max": _rounded(max(values), digits),
        "mean": _rounded(_mean(values), digits),
    }


def summarize_history(
    raw: dict[str, Any],
    *,
    tz: tzinfo | None,
    max_points: int = 100,
    max_changes: int = 50,
) -> dict[str, Any]:
    """Résumé d'un historique (contrat `heatwise/get_room_history` de la
    spec 010) assez court pour un assistant : séries ré-échantillonnées
    en au plus `max_points` points, statistiques, minutes de chauffe et
    derniers changements de consigne."""
    if not raw.get("has_data"):
        return {"has_data": False}
    temperature = raw["temperature"]
    group = max(1, -(-len(temperature) // max_points))  # division par excès
    start = datetime.fromisoformat(raw["start"])
    end = datetime.fromisoformat(raw["end"])

    changes = sorted(raw["regulation"], key=lambda r: r["at"])
    heating_seconds = 0.0
    target_changes: list[dict[str, Any]] = []
    previous_target: Any = object()
    for index, change in enumerate(changes):
        at = datetime.fromisoformat(change["at"])
        if change["heating"]:
            until = (
                datetime.fromisoformat(changes[index + 1]["at"])
                if index + 1 < len(changes)
                else end
            )
            heating_seconds += max(0.0, (min(until, end) - max(at, start)).total_seconds())
        if change["target"] != previous_target:
            target_changes.append({"at": local_minute(at, tz), "target_c": change["target"]})
            previous_target = change["target"]

    return {
        "start": local_minute(start, tz),
        "step_minutes": raw["bucket_seconds"] * group // 60,
        "temperature_c": _downsample(temperature, group, 1),
        "humidity_pct": _downsample(raw["humidity"], group, 0),
        "stats": {
            "temperature_c": _stats(temperature, 1),
            "humidity_pct": _stats(raw["humidity"], 0),
        },
        "heating_minutes": round(heating_seconds / 60),
        "target_changes": target_changes[-max_changes:],
    }
