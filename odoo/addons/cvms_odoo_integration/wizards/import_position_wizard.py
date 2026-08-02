import logging
from urllib.parse import urlsplit, urlunsplit

import requests

from odoo import _, fields, models
from odoo.exceptions import AccessError

from ..models.position import CvmsPayloadValidationError, validate_external_payload


_logger = logging.getLogger(__name__)

BASE_URL_PARAMETER = "cvms_odoo_integration.base_url"
EXTERNAL_POSITION_PATH = "/api/integrations/odoo/position"
HTTP_TIMEOUT = (5, 20)
MAX_RESPONSE_BYTES = 1_000_000
MAX_BASE_URL_LENGTH = 2048


class CvmsImportError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.safe_message = message


def normalize_base_url(value):
    if not isinstance(value, str):
        raise CvmsImportError("INVALID_URL", _("Enter a valid CVMS base URL."))

    raw_value = value.strip()
    if (
        not raw_value
        or len(raw_value) > MAX_BASE_URL_LENGTH
        or any(character in raw_value for character in ("\r", "\n", "\t"))
        or "?" in raw_value
        or "#" in raw_value
    ):
        raise CvmsImportError("INVALID_URL", _("Enter a valid CVMS base URL."))

    try:
        parsed = urlsplit(raw_value)
        parsed.port
    except ValueError as error:
        raise CvmsImportError(
            "INVALID_URL", _("Enter a valid CVMS base URL.")
        ) from error

    if (
        parsed.scheme.lower() not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise CvmsImportError("INVALID_URL", _("Enter a valid CVMS base URL."))

    path = parsed.path.rstrip("/")
    return urlunsplit(
        (parsed.scheme.lower(), parsed.netloc, path, "", "")
    )


class CvmsPositionImportWizard(models.TransientModel):
    _name = "cvms.position.import.wizard"
    _description = "Import CVMS position statistics"

    base_url = fields.Char(
        string="CVMS Base URL",
        required=True,
        default=lambda self: self.env["ir.config_parameter"]
        .sudo()
        .get_param(BASE_URL_PARAMETER, ""),
    )
    api_token = fields.Char(string="Position API Token", copy=False)
    result_state = fields.Selection(
        [("success", "Success"), ("error", "Error")],
        readonly=True,
        copy=False,
    )
    result_message = fields.Char(readonly=True, copy=False)

    def _reopen_action(self):
        self.ensure_one()
        return {
            "type": "ir.actions.act_window",
            "name": _("Import CVMS Position"),
            "res_model": self._name,
            "res_id": self.id,
            "view_mode": "form",
            "target": "new",
        }

    def _request_payload(self, base_url, api_token):
        endpoint = f"{base_url}{EXTERNAL_POSITION_PATH}"
        try:
            response = requests.get(
                endpoint,
                headers={
                    "Accept": "application/json",
                    "Authorization": f"Bearer {api_token}",
                },
                timeout=HTTP_TIMEOUT,
                allow_redirects=False,
                verify=True,
            )
        except requests.exceptions.Timeout as error:
            raise CvmsImportError(
                "TIMEOUT", _("CVMS did not respond in time. Try again later.")
            ) from error
        except requests.exceptions.SSLError as error:
            raise CvmsImportError(
                "TLS_ERROR", _("A secure connection to CVMS could not be established.")
            ) from error
        except requests.exceptions.ConnectionError as error:
            raise CvmsImportError(
                "CONNECTION_ERROR", _("CVMS could not be reached. Try again later.")
            ) from error
        except requests.exceptions.RequestException as error:
            raise CvmsImportError(
                "REQUEST_ERROR", _("The CVMS request could not be completed.")
            ) from error

        if 300 <= response.status_code < 400:
            raise CvmsImportError(
                "REDIRECT", _("CVMS returned an unexpected redirect.")
            )
        if response.status_code in {401, 403}:
            raise CvmsImportError(
                "UNAUTHORIZED", _("CVMS rejected the position API token.")
            )
        if response.status_code == 404:
            raise CvmsImportError(
                "NOT_FOUND", _("The CVMS Odoo endpoint was not found.")
            )
        if response.status_code == 429:
            raise CvmsImportError(
                "RATE_LIMIT", _("CVMS is busy. Try again later.")
            )
        if response.status_code in {500, 502, 503, 504}:
            raise CvmsImportError(
                "SERVER_ERROR", _("CVMS is temporarily unavailable.")
            )
        if response.status_code != 200:
            raise CvmsImportError(
                "HTTP_ERROR", _("CVMS returned an unexpected response.")
            )

        content_length = response.headers.get("Content-Length")
        if content_length:
            try:
                if int(content_length) > MAX_RESPONSE_BYTES:
                    raise CvmsImportError(
                        "PAYLOAD_TOO_LARGE",
                        _("CVMS returned more data than can be imported safely."),
                    )
            except ValueError as error:
                raise CvmsImportError(
                    "INVALID_RESPONSE", _("CVMS returned an invalid response.")
                ) from error

        content = response.content or b""
        if len(content) > MAX_RESPONSE_BYTES:
            raise CvmsImportError(
                "PAYLOAD_TOO_LARGE",
                _("CVMS returned more data than can be imported safely."),
            )
        content_type = response.headers.get("Content-Type", "").lower()
        if not content_type.startswith("application/json"):
            raise CvmsImportError(
                "INVALID_RESPONSE", _("CVMS returned an invalid response.")
            )

        try:
            return response.json()
        except ValueError as error:
            raise CvmsImportError(
                "INVALID_JSON", _("CVMS returned invalid JSON data.")
            ) from error

    def action_import(self):
        self.ensure_one()
        if not self.env.user.has_group("base.group_system"):
            raise AccessError(_("Only system administrators can import CVMS data."))

        api_token = (self.api_token or "").strip()
        result_state = "error"
        result_message = _("The CVMS position could not be imported.")

        try:
            if not api_token:
                raise CvmsImportError(
                    "MISSING_TOKEN", _("Enter a position API token.")
                )
            base_url = normalize_base_url(self.base_url)
            payload = self._request_payload(base_url, api_token)
            normalized_payload = validate_external_payload(payload)

            with self.env.cr.savepoint():
                position = self.env["cvms.position"]._sync_external_payload(
                    normalized_payload
                )
                self.env["ir.config_parameter"].sudo().set_param(
                    BASE_URL_PARAMETER, base_url
                )

            result_state = "success"
            result_message = _("Position imported successfully.")
            _logger.info("CVMS position import completed")
        except (CvmsImportError, CvmsPayloadValidationError) as error:
            result_message = getattr(
                error,
                "safe_message",
                _("CVMS returned invalid position data."),
            )
            error_code = getattr(error, "code", "INVALID_PAYLOAD")
            _logger.warning("CVMS position import failed (%s)", error_code)
        except Exception:
            _logger.error("CVMS position import failed unexpectedly")

        self.sudo().write(
            {
                "api_token": False,
                "result_state": result_state,
                "result_message": result_message,
            }
        )
        return self._reopen_action()
