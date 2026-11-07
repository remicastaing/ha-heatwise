"""Constantes partagées du plugin Heatwise."""
from __future__ import annotations

from datetime import timedelta

DOMAIN = "heatwise"

# Événement émis après toute modification de la programmation ou des
# paramètres généraux (spec 005), avec `{"room_ids": [...] | None}`
# (`None` = modification concernant toute la maison). Cf.
# `specs/005-heatwise-calendrier/research.md` R7.
EVENT_SCHEDULE_UPDATED = "heatwise_schedule_updated"

# --- Appairage d'une sonde Zigbee (spec 007) ---
# ZHA est facultatif : Heatwise n'importe rien de
# `homeassistant.components.zha` et n'appelle que ce qui suit
# (cf. specs/007-heatwise-appairage-sonde/research.md R2, R3).
ZHA_DOMAIN = "zha"
ZHA_SERVICE_PERMIT = "permit"
# Signal dispatcher interne de ZHA (`ZHA_GW_MSG`), non garanti stable :
# celui que relaie la commande `zha/devices/permit` au frontend (R3).
ZHA_GW_MSG_SIGNAL = "zha_gateway_message"
ZHA_MSG_DEVICE_JOINED = "device_joined"
ZHA_MSG_DEVICE_FULLY_INITIALIZED = "device_fully_initialized"
# Cluster Zigbee « Temperature Measurement », lu dans la signature de
# l'appareil pour distinguer une non-sonde d'une sonde dont ZHA n'a pas
# créé les entités (research R4bis).
ZHA_TEMPERATURE_CLUSTER = 0x0402

# Délais de la session d'appairage (R5).
PAIRING_DURATION = timedelta(seconds=180)
PAIRING_CONFIG_TIMEOUT = timedelta(seconds=120)
PAIRING_ENTITIES_TIMEOUT = timedelta(seconds=10)
PAIRING_SETTLE_DELAY = timedelta(seconds=2)
# Attente des capteurs après le rechargement de ZHA qui répare une sonde
# appairée sans capteurs (research R4ter).
PAIRING_RELOAD_ENTITIES_TIMEOUT = timedelta(seconds=30)

# --- Régulation automatique (spec 008) ---
# Événement émis quand l'état de régulation d'une ou plusieurs pièces
# change, avec `{"room_ids": [...]}` (research R8).
EVENT_REGULATION_UPDATED = "heatwise_regulation_updated"
# Signal dispatcher interne émis après ajout ou suppression d'un
# radiateur : la régulation réévalue toutes les pièces (research R4).
SIGNAL_RADIATORS_CHANGED = "heatwise_radiators_changed"
# Réévaluation au moins chaque minute à défaut d'événement (FR-007).
REGULATION_TICK = timedelta(seconds=60)
# Renvoi de l'ordre courant de chaque radiateur, bien en dessous de la
# coupure matérielle d'1 h du récepteur X2D, pour rattraper vite une trame
# perdue (spec 011 FR-001 : 5 min, au lieu des 15 min de la spec 008).
REGULATION_RESEND = timedelta(minutes=5)
# Suspension de la régulation d'une pièce après une action manuelle
# (FR-015, research R6).
MANUAL_SUSPENSION = timedelta(hours=1)

# --- Historique des mesures (spec 010) ---
# Fréquence d'enregistrement, en minutes (FR-009).
HISTORY_INTERVAL_DEFAULT = 10
HISTORY_INTERVAL_MIN = 1
HISTORY_INTERVAL_MAX = 60
# Base SQLite propre à Heatwise, dans le dossier de configuration HA
# (research R1).
HISTORY_DB_FILENAME = "heatwise_history.db"
# Périodes du graphique et pas minimal de regroupement, en secondes
# (research R6).
HISTORY_PERIODS = {
    "24h": timedelta(hours=24),
    "7d": timedelta(days=7),
    "30d": timedelta(days=30),
}
HISTORY_PERIOD_STEPS = {"24h": 60, "7d": 900, "30d": 3600}
# Statut enregistré pour une pièce sans radiateur (data-model.md).
HISTORY_STATUS_NO_RADIATOR = "no_radiator"
# Source de température extérieure (spec 013, research R4) : capteur de
# température ou entité météo.
OUTDOOR_DOMAINS = ("sensor", "weather")
OUTDOOR_DEVICE_CLASS = "temperature"

# --- Assistant IA / MCP (spec 012) ---
# API LLM enregistrée auprès de Home Assistant, publiée par le serveur
# MCP natif (`mcp_server`) et sélectionnable par Assist (research R1).
LLM_API_ID = "heatwise"
LLM_API_NAME = "Heatwise"
# Bornes d'une consigne temporaire (research R10).
TEMPORARY_TARGET_MIN = timedelta(minutes=30)
TEMPORARY_TARGET_MAX = timedelta(hours=24)
# Taille maximale des réponses d'historique (research R8).
LLM_SERIES_MAX_POINTS = 100
LLM_TARGET_CHANGES_MAX = 50
