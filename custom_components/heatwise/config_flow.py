"""Config flow Heatwise : confirmation d'installation + port du dongle
RFPlayer (FR-022).

Le port peut aussi être modifié après coup via la reconfiguration standard
de Home Assistant (bouton « Reconfigurer » de la page de l'intégration) —
une étape de `config_flow`, pas un `options_flow`, conformément à la
constitution (panneau personnalisé pour toute gestion, `config_flow` pour
la configuration technique minimale).
"""
from __future__ import annotations

import voluptuous as vol

from homeassistant import config_entries

from .const import DOMAIN

STEP_USER_DATA_SCHEMA = vol.Schema({vol.Required("port"): str})


class HeatwiseConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Flow de configuration Heatwise."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict | None = None
    ) -> config_entries.ConfigFlowResult:
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        if user_input is not None:
            return self.async_create_entry(title="Heatwise", data=user_input)

        return self.async_show_form(step_id="user", data_schema=STEP_USER_DATA_SCHEMA)

    async def async_step_reconfigure(
        self, user_input: dict | None = None
    ) -> config_entries.ConfigFlowResult:
        """Modifie le port du dongle RFPlayer d'une installation existante."""
        entry = self._get_reconfigure_entry()

        if user_input is not None:
            return self.async_update_reload_and_abort(entry, data=user_input)

        return self.async_show_form(
            step_id="reconfigure",
            data_schema=self.add_suggested_values_to_schema(
                STEP_USER_DATA_SCHEMA, entry.data
            ),
        )
