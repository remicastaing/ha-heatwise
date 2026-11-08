"""Téléchargement de la base d'historique (spec 013).

Sert une copie cohérente de `heatwise_history.db` pour le banc d'essai
thermique, sans accès au système de fichiers de Home Assistant. Réservé aux
administrateurs ; le panneau passe par un lien signé (`auth/sign_path`), car une
navigation du navigateur n'envoie pas de jeton. Une panne ici n'affecte ni
l'enregistrement, ni la régulation.
"""
from __future__ import annotations

from http import HTTPStatus
import logging
from pathlib import Path
import shutil
import tempfile
from typing import BinaryIO

from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import Unauthorized
from homeassistant.util import dt as dt_util

from .const import DOMAIN
from .history_recorder import HistoryUnavailableError, get_history_recorder

_LOGGER = logging.getLogger(__name__)

CHUNK_SIZE = 1 << 20
_REGISTERED = "history_download_registered"


class HistoryDownloadView(HomeAssistantView):
    url = "/api/heatwise/history.db"
    name = "api:heatwise:history_db"
    requires_auth = True

    async def get(self, request: web.Request) -> web.StreamResponse:
        if not request["hass_user"].is_admin:
            raise Unauthorized()
        hass: HomeAssistant = request.app["hass"]
        recorder = get_history_recorder(hass)
        if recorder is None:
            return self.json_message("Historique indisponible.", HTTPStatus.SERVICE_UNAVAILABLE)

        folder = await hass.async_add_executor_job(tempfile.mkdtemp, "", "heatwise_")
        try:
            copy = Path(folder) / "heatwise_history.db"
            try:
                await recorder.async_export(str(copy))
            except HistoryUnavailableError:
                return self.json_message(
                    "Historique indisponible.", HTTPStatus.SERVICE_UNAVAILABLE
                )
            return await self._send(hass, request, copy)
        finally:
            await hass.async_add_executor_job(shutil.rmtree, folder, True)

    async def _send(
        self, hass: HomeAssistant, request: web.Request, copy: Path
    ) -> web.StreamResponse:
        day = dt_util.now().strftime("%Y-%m-%d")
        size = (await hass.async_add_executor_job(copy.stat)).st_size
        response = web.StreamResponse(
            headers={
                "Content-Type": "application/octet-stream",
                "Content-Disposition": f'attachment; filename="heatwise_history-{day}.db"',
                "Content-Length": str(size),
            }
        )
        await response.prepare(request)
        file: BinaryIO = await hass.async_add_executor_job(copy.open, "rb")
        try:
            while chunk := await hass.async_add_executor_job(file.read, CHUNK_SIZE):
                await response.write(chunk)
        finally:
            await hass.async_add_executor_job(file.close)
        await response.write_eof()
        return response


def async_register(hass: HomeAssistant) -> None:
    """Une seule fois par démarrage : une vue ne se retire pas, et elle cherche
    le recorder courant à chaque appel, donc elle survit à un rechargement."""
    data = hass.data.setdefault(DOMAIN, {})
    if not data.get(_REGISTERED):
        hass.http.register_view(HistoryDownloadView())
        data[_REGISTERED] = True
