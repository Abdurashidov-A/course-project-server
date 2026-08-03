import json
from copy import deepcopy
from unittest.mock import patch
from xml.etree import ElementTree

import requests

from odoo import Command
from odoo.exceptions import AccessError
from odoo.tests import TransactionCase, tagged

from ..models.position import CvmsPosition
from ..wizards.import_position_wizard import MAX_RESPONSE_BYTES


WIZARD_MODULE = (
    "odoo.addons.cvms_odoo_integration.wizards.import_position_wizard"
)
REQUEST_GET = f"{WIZARD_MODULE}.requests.get"
MODULE_LOGGER = f"{WIZARD_MODULE}._logger"
API_TOKEN = "cvms_odoo_test_token_private_7f31"
PRIVATE_MARKER = "PRIVATE_TEXT_MARKER_7f31"


class FakeResponse:
    def __init__(self, status_code=200, payload=None, content=None, headers=None):
        self.status_code = status_code
        self._payload = payload
        self._json_error = None
        if content is None:
            content = json.dumps(payload or {}).encode("utf-8")
        self.content = content
        self.headers = {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": str(len(content)),
            **(headers or {}),
        }

    def json(self):
        if self._json_error:
            raise self._json_error
        return deepcopy(self._payload)


def build_payload():
    return {
        "position": {"id": 8, "title": "Frontend Developer"},
        "dataset": {"cvStatus": "PUBLISHED", "publishedCvCount": 2},
        "attributes": [
            {
                "id": 1,
                "name": "Level",
                "type": "STRING",
                "isRequired": True,
                "sortOrder": 2,
                "statistics": {
                    "kind": "POPULAR_VALUES",
                    "filledCount": 2,
                    "missingCount": 0,
                    "topValues": [
                        {"value": "Senior", "count": 1},
                        {"value": "Middle", "count": 1},
                    ],
                },
            },
            {
                "id": 2,
                "name": "English Level",
                "type": "SELECT",
                "isRequired": False,
                "sortOrder": 1,
                "statistics": {
                    "kind": "POPULAR_VALUES",
                    "filledCount": 1,
                    "missingCount": 1,
                    "topValues": [{"value": "Advanced", "count": 1}],
                },
            },
            {
                "id": 3,
                "name": "Experience Years",
                "type": "NUMERIC",
                "isRequired": True,
                "sortOrder": 3,
                "statistics": {
                    "kind": "NUMERIC",
                    "filledCount": 2,
                    "missingCount": 0,
                    "average": 5.5,
                    "min": 4,
                    "max": 7,
                },
            },
            {
                "id": 4,
                "name": "Remote",
                "type": "BOOLEAN",
                "isRequired": False,
                "sortOrder": 4,
                "statistics": {
                    "kind": "BOOLEAN",
                    "filledCount": 2,
                    "missingCount": 0,
                    "trueCount": 1,
                    "falseCount": 1,
                },
            },
            {
                "id": 5,
                "name": "Available From",
                "type": "DATE",
                "isRequired": False,
                "sortOrder": 5,
                "statistics": {
                    "kind": "DATE_RANGE",
                    "filledCount": 2,
                    "missingCount": 0,
                    "earliest": "2026-01-15T23:00:00-05:00",
                    "latest": "2026-06-30T01:00:00+05:00",
                },
            },
            {
                "id": 6,
                "name": "Employment Period",
                "type": "PERIOD",
                "isRequired": False,
                "sortOrder": 6,
                "statistics": {
                    "kind": "PERIOD_RANGE",
                    "filledCount": 2,
                    "missingCount": 0,
                    "earliestStart": "2024-01-01T23:00:00-05:00",
                    "latestEnd": "2026-07-31T01:00:00+05:00",
                },
            },
            {
                "id": 7,
                "name": "Profile Image",
                "type": "IMAGE",
                "isRequired": False,
                "sortOrder": 7,
                "statistics": {
                    "kind": "COMPLETENESS",
                    "filledCount": 1,
                    "missingCount": 1,
                },
            },
            {
                "id": 8,
                "name": "Candidate Summary",
                "type": "TEXT",
                "isRequired": False,
                "sortOrder": 8,
                "statistics": {
                    "kind": "COMPLETENESS",
                    "filledCount": 2,
                    "missingCount": 0,
                },
            },
        ],
    }


@tagged("post_install", "-at_install")
class TestCvmsPositionImport(TransactionCase):
    def _create_wizard(self, base_url="https://cvms.example.test/", token=API_TOKEN):
        return self.env["cvms.position.import.wizard"].create(
            {"base_url": base_url, "api_token": token}
        )

    def _import_payload(self, payload, wizard=None):
        wizard = wizard or self._create_wizard()
        response = FakeResponse(payload=payload)
        with patch(REQUEST_GET, return_value=response) as request_get:
            action = wizard.action_import()
        wizard.invalidate_recordset()
        return wizard, action, request_get

    def test_success_maps_all_statistics_and_uses_safe_get(self):
        wizard, action, request_get = self._import_payload(build_payload())

        self.assertEqual(wizard.result_state, "success")
        self.assertFalse(wizard.api_token)
        self.assertEqual(action["res_id"], wizard.id)
        request_get.assert_called_once_with(
            "https://cvms.example.test/api/integrations/odoo/position",
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {API_TOKEN}",
            },
            timeout=(5, 20),
            allow_redirects=False,
            verify=True,
        )

        position = self.env["cvms.position"].search(
            [("external_position_id", "=", 8)]
        )
        self.assertEqual(len(position), 1)
        self.assertEqual(position.title, "Frontend Developer")
        self.assertEqual(position.published_cv_count, 2)
        self.assertEqual(len(position.attribute_ids), 8)
        ordered_attributes = self.env["cvms.position.attribute"].search(
            [("position_id", "=", position.id)]
        )
        self.assertEqual(ordered_attributes.mapped("sort_order"), list(range(1, 9)))
        self.assertNotIn(API_TOKEN, json.dumps(position.read(), default=str))

        attributes = {
            attribute.external_attribute_id: attribute
            for attribute in position.attribute_ids
        }
        self.assertEqual(attributes[1].statistics_kind, "POPULAR_VALUES")
        self.assertEqual(attributes[1].popular_value_ids.mapped("count"), [1, 1])
        self.assertEqual(attributes[3].statistics_kind, "NUMERIC")
        self.assertEqual(attributes[3].average_value, 5.5)
        self.assertEqual(attributes[4].true_count, 1)
        self.assertEqual(attributes[4].false_count, 1)
        self.assertEqual(str(attributes[5].earliest_date), "2026-01-15")
        self.assertEqual(str(attributes[5].latest_date), "2026-06-30")
        self.assertEqual(str(attributes[6].earliest_period_start), "2024-01-01")
        self.assertEqual(str(attributes[6].latest_period_end), "2026-07-31")
        self.assertEqual(attributes[7].statistics_kind, "COMPLETENESS")
        self.assertEqual(attributes[8].statistics_kind, "COMPLETENESS")
        self.assertEqual(attributes[8].filled_count, 2)
        self.assertNotIn("text_value", attributes[8]._fields)
        self.assertNotIn("raw_text", attributes[8]._fields)

    def test_text_private_data_is_rejected_and_never_persisted_or_reported(self):
        payload = build_payload()
        text_attribute = payload["attributes"][-1]
        text_attribute["statistics"]["topValues"] = [
            {
                "value": f"{PRIVATE_MARKER} [private](https://private.example)",
                "count": 1,
            }
        ]
        wizard = self._create_wizard()

        with patch(MODULE_LOGGER) as logger, patch(
            REQUEST_GET, return_value=FakeResponse(payload=payload)
        ):
            wizard.action_import()

        wizard.invalidate_recordset()
        serialized_result = json.dumps(
            {
                "state": wizard.result_state,
                "message": wizard.result_message,
                "logs": [str(call) for call in logger.mock_calls],
            }
        )
        self.assertEqual(wizard.result_state, "error")
        self.assertFalse(wizard.api_token)
        self.assertFalse(self.env["cvms.position"].search_count([]))
        self.assertNotIn(API_TOKEN, serialized_result)
        self.assertNotIn(PRIVATE_MARKER, serialized_result)
        self.assertNotIn("https://private.example", serialized_result)

    def test_repeated_import_updates_and_removes_stale_children(self):
        first_payload = build_payload()
        self._import_payload(first_payload)
        position = self.env["cvms.position"].search(
            [("external_position_id", "=", 8)]
        )
        original_attribute = position.attribute_ids.filtered(
            lambda attribute: attribute.external_attribute_id == 1
        )
        self.assertEqual(len(original_attribute.popular_value_ids), 2)

        second_payload = build_payload()
        second_payload["position"]["title"] = "Frontend Platform Developer"
        second_payload["attributes"] = [second_payload["attributes"][0]]
        second_payload["attributes"][0]["statistics"]["topValues"] = [
            {"value": "Lead", "count": 2}
        ]
        self._import_payload(second_payload)

        positions = self.env["cvms.position"].search(
            [("external_position_id", "=", 8)]
        )
        self.assertEqual(len(positions), 1)
        self.assertEqual(positions.title, "Frontend Platform Developer")
        self.assertEqual(len(positions.attribute_ids), 1)
        self.assertEqual(positions.attribute_ids.external_attribute_id, 1)
        self.assertEqual(positions.attribute_ids.popular_value_ids.mapped("value"), ["Lead"])

    def test_unknown_statistics_kind_is_stored_without_unknown_payload(self):
        payload = build_payload()
        payload["attributes"] = [payload["attributes"][0]]
        payload["attributes"][0]["statistics"] = {
            "kind": "FUTURE_AGGREGATE",
            "private": PRIVATE_MARKER,
            "values": ["must-not-be-stored"],
        }
        self._import_payload(payload)

        attribute = self.env["cvms.position.attribute"].search(
            [("external_attribute_id", "=", 1)]
        )
        self.assertEqual(attribute.statistics_kind, "UNKNOWN")
        self.assertEqual(attribute.filled_count, 0)
        self.assertEqual(attribute.missing_count, 2)
        self.assertFalse(attribute.popular_value_ids)
        self.assertNotIn(
            PRIVATE_MARKER,
            json.dumps(attribute.read(), default=str),
        )

    def test_http_status_errors_are_safe_and_clear_token(self):
        for status_code in (401, 403, 404, 429, 500, 502, 503, 504):
            with self.subTest(status_code=status_code):
                wizard = self._create_wizard()
                response = FakeResponse(
                    status_code=status_code,
                    payload={"message": f"{PRIVATE_MARKER} {API_TOKEN}"},
                )
                with patch(REQUEST_GET, return_value=response):
                    wizard.action_import()
                wizard.invalidate_recordset()
                self.assertEqual(wizard.result_state, "error")
                self.assertFalse(wizard.api_token)
                self.assertNotIn(API_TOKEN, wizard.result_message)
                self.assertNotIn(PRIVATE_MARKER, wizard.result_message)

    def test_network_redirect_json_url_and_size_errors_are_safe(self):
        failures = [
            requests.exceptions.Timeout("private timeout"),
            requests.exceptions.ConnectionError("private connection"),
            requests.exceptions.SSLError("private tls"),
        ]
        for error in failures:
            with self.subTest(error=type(error).__name__):
                wizard = self._create_wizard()
                with patch(REQUEST_GET, side_effect=error):
                    wizard.action_import()
                wizard.invalidate_recordset()
                self.assertEqual(wizard.result_state, "error")
                self.assertFalse(wizard.api_token)
                self.assertNotIn("private", wizard.result_message.lower())

        redirect_wizard = self._create_wizard()
        with patch(REQUEST_GET, return_value=FakeResponse(status_code=302)):
            redirect_wizard.action_import()
        redirect_wizard.invalidate_recordset()
        self.assertEqual(redirect_wizard.result_state, "error")
        self.assertFalse(redirect_wizard.api_token)

        malformed_response = FakeResponse(payload=None, content=b"{not-json")
        malformed_response._json_error = ValueError("private malformed body")
        malformed_wizard = self._create_wizard()
        with patch(REQUEST_GET, return_value=malformed_response):
            malformed_wizard.action_import()
        malformed_wizard.invalidate_recordset()
        self.assertEqual(malformed_wizard.result_state, "error")
        self.assertFalse(malformed_wizard.api_token)

        oversized_wizard = self._create_wizard()
        oversized_response = FakeResponse(content=b"x" * (MAX_RESPONSE_BYTES + 1))
        with patch(REQUEST_GET, return_value=oversized_response):
            oversized_wizard.action_import()
        oversized_wizard.invalidate_recordset()
        self.assertEqual(oversized_wizard.result_state, "error")
        self.assertFalse(oversized_wizard.api_token)

        invalid_url_wizard = self._create_wizard(
            base_url="https://user:password@cvms.example.test?secret=1"
        )
        with patch(REQUEST_GET) as request_get:
            invalid_url_wizard.action_import()
        invalid_url_wizard.invalidate_recordset()
        request_get.assert_not_called()
        self.assertEqual(invalid_url_wizard.result_state, "error")
        self.assertFalse(invalid_url_wizard.api_token)

    def test_invalid_date_and_counts_are_rejected_before_write(self):
        for mutator in (
            lambda payload: payload["attributes"][4]["statistics"].update(
                {"earliest": "not-a-date"}
            ),
            lambda payload: payload["attributes"][7]["statistics"].update(
                {"filledCount": 1, "missingCount": 0}
            ),
        ):
            with self.subTest(mutator=mutator):
                payload = build_payload()
                mutator(payload)
                wizard, _action, _request_get = self._import_payload(payload)
                self.assertEqual(wizard.result_state, "error")
                self.assertFalse(wizard.api_token)
                self.assertFalse(self.env["cvms.position"].search_count([]))

    def test_sync_failure_rolls_back_data_but_commits_token_cleanup(self):
        self._import_payload(build_payload())
        position = self.env["cvms.position"].search(
            [("external_position_id", "=", 8)]
        )
        original_title = position.title
        wizard = self._create_wizard()

        def failing_sync(recordset, payload):
            existing = recordset.sudo().search(
                [("external_position_id", "=", payload["external_position_id"])]
            )
            existing.write({"title": "PARTIAL UPDATE"})
            raise RuntimeError("private sync failure")

        with patch(REQUEST_GET, return_value=FakeResponse(payload=build_payload())), patch.object(
            CvmsPosition,
            "_sync_external_payload",
            failing_sync,
        ):
            wizard.action_import()

        wizard.invalidate_recordset()
        position.invalidate_recordset()
        self.assertEqual(wizard.result_state, "error")
        self.assertFalse(wizard.api_token)
        self.assertEqual(position.title, original_title)
        self.assertEqual(len(position.attribute_ids), 8)

    def test_internal_users_keep_read_only_access_and_cannot_import(self):
        internal_group = self.env.ref("base.group_user")
        user = self.env["res.users"].create(
            {
                "name": "CVMS Read Only User",
                "login": "cvms-read-only-user",
                "group_ids": [Command.set([internal_group.id])],
            }
        )
        position = self.env["cvms.position"].sudo().create(
            {
                "external_position_id": 99,
                "title": "Read Only Position",
                "cv_status": "PUBLISHED",
                "published_cv_count": 0,
            }
        )

        self.assertEqual(position.with_user(user).read(["title"])[0]["title"], "Read Only Position")
        with self.assertRaises(AccessError):
            self.env["cvms.position"].with_user(user).create(
                {
                    "external_position_id": 100,
                    "title": "Forbidden",
                    "cv_status": "PUBLISHED",
                    "published_cv_count": 0,
                }
            )
        with self.assertRaises(AccessError):
            position.with_user(user).write({"title": "Forbidden"})
        with self.assertRaises(AccessError):
            position.with_user(user).unlink()
        with self.assertRaises(AccessError):
            self.env["cvms.position.import.wizard"].with_user(user).create(
                {"base_url": "https://cvms.example.test", "api_token": API_TOKEN}
            )

    def test_read_only_navigation_views_actions_and_acl(self):
        root_menu = self.env.ref("cvms_odoo_integration.cvms_menu_root")
        position_menu = self.env.ref(
            "cvms_odoo_integration.cvms_menu_imported_positions"
        )
        attribute_menu = self.env.ref(
            "cvms_odoo_integration.cvms_menu_attributes"
        )
        statistics_menu = self.env.ref(
            "cvms_odoo_integration.cvms_menu_statistics"
        )
        import_menu = self.env.ref(
            "cvms_odoo_integration.cvms_menu_import_position"
        )

        self.assertFalse(root_menu.action)
        self.assertEqual(position_menu.parent_id, root_menu)
        self.assertEqual(attribute_menu.parent_id, root_menu)
        self.assertEqual(statistics_menu.parent_id, root_menu)
        self.assertEqual(import_menu.parent_id, root_menu)
        child_menus = self.env["ir.ui.menu"].search(
            [("parent_id", "=", root_menu.id)],
            order="sequence, id",
        )
        self.assertEqual(child_menus[0], position_menu)
        self.assertGreater(import_menu.sequence, statistics_menu.sequence)

        expected_actions = {
            "cvms_odoo_integration.cvms_position_action": (
                "cvms.position",
                "cvms_odoo_integration.cvms_position_view_list",
            ),
            "cvms_odoo_integration.cvms_position_attribute_action": (
                "cvms.position.attribute",
                "cvms_odoo_integration.cvms_position_attribute_view_list",
            ),
            "cvms_odoo_integration.cvms_position_statistics_action": (
                "cvms.position.attribute",
                "cvms_odoo_integration.cvms_position_attribute_statistics_view_list",
            ),
        }
        for action_xml_id, (model_name, list_view_xml_id) in expected_actions.items():
            with self.subTest(action=action_xml_id):
                action = self.env.ref(action_xml_id)
                self.assertEqual(action.res_model, model_name)
                self.assertEqual(action.view_mode, "list,form")
                self.assertEqual(action.view_id, self.env.ref(list_view_xml_id))
                self.assertIn(model_name, self.env.registry.models)

        import_action = self.env.ref(
            "cvms_odoo_integration.cvms_position_import_wizard_action"
        )
        self.assertEqual(import_action.res_model, "cvms.position.import.wizard")
        self.assertEqual(import_action.view_mode, "form")
        self.assertEqual(import_action.target, "new")
        self.assertIn(self.env.ref("base.group_system"), import_menu.group_ids)

        read_only_views = {
            "cvms_odoo_integration.cvms_position_view_list": "list",
            "cvms_odoo_integration.cvms_position_view_form": "form",
            "cvms_odoo_integration.cvms_position_attribute_view_list": "list",
            "cvms_odoo_integration.cvms_position_attribute_statistics_view_list": "list",
            "cvms_odoo_integration.cvms_position_attribute_view_form": "form",
            "cvms_odoo_integration.cvms_position_attribute_popular_value_view_list": "list",
            "cvms_odoo_integration.cvms_position_attribute_popular_value_view_form": "form",
        }
        forbidden_fields = {
            "api_token",
            "token",
            "token_hash",
            "management_credential",
            "authorization",
            "text_value",
            "raw_text",
            "candidate_id",
            "user_id",
            "email",
        }
        for view_xml_id, root_tag in read_only_views.items():
            with self.subTest(view=view_xml_id):
                view = self.env.ref(view_xml_id)
                arch = ElementTree.fromstring(view.arch_db)
                self.assertEqual(arch.tag, root_tag)
                self.assertEqual(arch.attrib.get("create"), "false")
                self.assertEqual(arch.attrib.get("edit"), "false")
                self.assertEqual(arch.attrib.get("delete"), "false")
                self.assertIn(view.model, self.env.registry.models)
                field_names = {
                    field.attrib["name"]
                    for field in arch.iter("field")
                    if "name" in field.attrib
                }
                self.assertFalse(field_names & forbidden_fields)

        persistent_acl = {
            "cvms_odoo_integration.access_cvms_position_user",
            "cvms_odoo_integration.access_cvms_position_attribute_user",
            "cvms_odoo_integration.access_cvms_position_attribute_popular_value_user",
        }
        internal_group = self.env.ref("base.group_user")
        for acl_xml_id in persistent_acl:
            with self.subTest(acl=acl_xml_id):
                acl = self.env.ref(acl_xml_id)
                self.assertEqual(acl.group_id, internal_group)
                self.assertTrue(acl.perm_read)
                self.assertFalse(acl.perm_write)
                self.assertFalse(acl.perm_create)
                self.assertFalse(acl.perm_unlink)

        wizard_acl = self.env.ref(
            "cvms_odoo_integration.access_cvms_position_import_wizard_system"
        )
        self.assertEqual(wizard_acl.group_id, self.env.ref("base.group_system"))
