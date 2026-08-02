import math
from datetime import date, datetime

from odoo import api, fields, models


MAX_ATTRIBUTES = 500
MAX_POPULAR_VALUES = 5
MAX_TITLE_LENGTH = 255
MAX_POPULAR_VALUE_LENGTH = 1000

ATTRIBUTE_TYPES = {
    "STRING",
    "SELECT",
    "NUMERIC",
    "BOOLEAN",
    "DATE",
    "PERIOD",
    "IMAGE",
    "TEXT",
}
KNOWN_STATISTICS_KINDS = {
    "POPULAR_VALUES",
    "NUMERIC",
    "BOOLEAN",
    "DATE_RANGE",
    "PERIOD_RANGE",
    "COMPLETENESS",
}
EXPECTED_KIND_BY_TYPE = {
    "STRING": "POPULAR_VALUES",
    "SELECT": "POPULAR_VALUES",
    "NUMERIC": "NUMERIC",
    "BOOLEAN": "BOOLEAN",
    "DATE": "DATE_RANGE",
    "PERIOD": "PERIOD_RANGE",
    "IMAGE": "COMPLETENESS",
    "TEXT": "COMPLETENESS",
}


class CvmsPayloadValidationError(Exception):
    pass


def _invalid_payload():
    raise CvmsPayloadValidationError("CVMS returned invalid position data.")


def _require_exact_keys(value, expected_keys):
    if not isinstance(value, dict) or set(value) != set(expected_keys):
        _invalid_payload()


def _require_non_negative_integer(value):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        _invalid_payload()
    return value


def _require_positive_integer(value):
    value = _require_non_negative_integer(value)
    if value == 0:
        _invalid_payload()
    return value


def _require_string(value, maximum_length):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum_length:
        _invalid_payload()
    return value.strip()


def _require_optional_finite_number(value):
    if value is None:
        return False
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _invalid_payload()
    try:
        numeric_value = float(value)
    except (OverflowError, ValueError):
        _invalid_payload()
    if not math.isfinite(numeric_value):
        _invalid_payload()
    return numeric_value


def _require_counts(statistics, published_cv_count):
    filled_count = _require_non_negative_integer(statistics.get("filledCount"))
    missing_count = _require_non_negative_integer(statistics.get("missingCount"))
    if filled_count + missing_count != published_cv_count:
        _invalid_payload()
    return filled_count, missing_count


def _parse_iso_date(value):
    if not isinstance(value, str) or not value.strip():
        _invalid_payload()

    normalized_value = value.strip()
    try:
        if len(normalized_value) == 10:
            return date.fromisoformat(normalized_value)
        return datetime.fromisoformat(normalized_value.replace("Z", "+00:00")).date()
    except ValueError:
        _invalid_payload()


def _empty_statistics_values(kind, published_cv_count):
    return {
        "statistics_kind": kind,
        "filled_count": 0,
        "missing_count": published_cv_count,
        "true_count": 0,
        "false_count": 0,
        "average_value": False,
        "minimum_value": False,
        "maximum_value": False,
        "earliest_date": False,
        "latest_date": False,
        "earliest_period_start": False,
        "latest_period_end": False,
        "popular_values": [],
    }


def _validate_popular_values(statistics, published_cv_count):
    _require_exact_keys(
        statistics,
        {"kind", "filledCount", "missingCount", "topValues"},
    )
    filled_count, missing_count = _require_counts(statistics, published_cv_count)
    top_values = statistics["topValues"]
    if not isinstance(top_values, list) or len(top_values) > MAX_POPULAR_VALUES:
        _invalid_payload()

    normalized_values = []
    seen_values = set()
    total_top_count = 0
    for item in top_values:
        _require_exact_keys(item, {"value", "count"})
        value = _require_string(item["value"], MAX_POPULAR_VALUE_LENGTH)
        count = _require_non_negative_integer(item["count"])
        if count == 0 or value in seen_values:
            _invalid_payload()
        seen_values.add(value)
        total_top_count += count
        normalized_values.append({"value": value, "count": count})

    if total_top_count > filled_count or (filled_count == 0 and top_values):
        _invalid_payload()

    values = _empty_statistics_values("POPULAR_VALUES", published_cv_count)
    values.update(
        {
            "filled_count": filled_count,
            "missing_count": missing_count,
            "popular_values": normalized_values,
        }
    )
    return values


def _validate_numeric(statistics, published_cv_count):
    _require_exact_keys(
        statistics,
        {"kind", "filledCount", "missingCount", "average", "min", "max"},
    )
    filled_count, missing_count = _require_counts(statistics, published_cv_count)
    average = _require_optional_finite_number(statistics["average"])
    minimum = _require_optional_finite_number(statistics["min"])
    maximum = _require_optional_finite_number(statistics["max"])

    if filled_count == 0:
        if any(value is not False for value in (average, minimum, maximum)):
            _invalid_payload()
    elif any(value is False for value in (average, minimum, maximum)):
        _invalid_payload()
    elif not minimum <= average <= maximum:
        _invalid_payload()

    values = _empty_statistics_values("NUMERIC", published_cv_count)
    values.update(
        {
            "filled_count": filled_count,
            "missing_count": missing_count,
            "average_value": average,
            "minimum_value": minimum,
            "maximum_value": maximum,
        }
    )
    return values


def _validate_boolean(statistics, published_cv_count):
    _require_exact_keys(
        statistics,
        {"kind", "filledCount", "missingCount", "trueCount", "falseCount"},
    )
    filled_count, missing_count = _require_counts(statistics, published_cv_count)
    true_count = _require_non_negative_integer(statistics["trueCount"])
    false_count = _require_non_negative_integer(statistics["falseCount"])
    if true_count + false_count != filled_count:
        _invalid_payload()

    values = _empty_statistics_values("BOOLEAN", published_cv_count)
    values.update(
        {
            "filled_count": filled_count,
            "missing_count": missing_count,
            "true_count": true_count,
            "false_count": false_count,
        }
    )
    return values


def _validate_date_range(statistics, published_cv_count):
    _require_exact_keys(
        statistics,
        {"kind", "filledCount", "missingCount", "earliest", "latest"},
    )
    filled_count, missing_count = _require_counts(statistics, published_cv_count)
    earliest = statistics["earliest"]
    latest = statistics["latest"]
    if filled_count == 0:
        if earliest is not None or latest is not None:
            _invalid_payload()
        earliest_date = latest_date = False
    else:
        earliest_date = _parse_iso_date(earliest)
        latest_date = _parse_iso_date(latest)
        if earliest_date > latest_date:
            _invalid_payload()

    values = _empty_statistics_values("DATE_RANGE", published_cv_count)
    values.update(
        {
            "filled_count": filled_count,
            "missing_count": missing_count,
            "earliest_date": earliest_date,
            "latest_date": latest_date,
        }
    )
    return values


def _validate_period_range(statistics, published_cv_count):
    _require_exact_keys(
        statistics,
        {
            "kind",
            "filledCount",
            "missingCount",
            "earliestStart",
            "latestEnd",
        },
    )
    filled_count, missing_count = _require_counts(statistics, published_cv_count)
    earliest = statistics["earliestStart"]
    latest = statistics["latestEnd"]
    if filled_count == 0:
        if earliest is not None or latest is not None:
            _invalid_payload()
        earliest_date = latest_date = False
    else:
        earliest_date = _parse_iso_date(earliest)
        latest_date = _parse_iso_date(latest)
        if earliest_date > latest_date:
            _invalid_payload()

    values = _empty_statistics_values("PERIOD_RANGE", published_cv_count)
    values.update(
        {
            "filled_count": filled_count,
            "missing_count": missing_count,
            "earliest_period_start": earliest_date,
            "latest_period_end": latest_date,
        }
    )
    return values


def _validate_completeness(statistics, published_cv_count):
    _require_exact_keys(statistics, {"kind", "filledCount", "missingCount"})
    filled_count, missing_count = _require_counts(statistics, published_cv_count)
    values = _empty_statistics_values("COMPLETENESS", published_cv_count)
    values.update(
        {
            "filled_count": filled_count,
            "missing_count": missing_count,
        }
    )
    return values


STATISTICS_VALIDATORS = {
    "POPULAR_VALUES": _validate_popular_values,
    "NUMERIC": _validate_numeric,
    "BOOLEAN": _validate_boolean,
    "DATE_RANGE": _validate_date_range,
    "PERIOD_RANGE": _validate_period_range,
    "COMPLETENESS": _validate_completeness,
}


def _validate_statistics(attribute_type, statistics, published_cv_count):
    if not isinstance(statistics, dict):
        _invalid_payload()
    kind = statistics.get("kind")
    if not isinstance(kind, str) or not kind:
        _invalid_payload()

    if kind not in KNOWN_STATISTICS_KINDS:
        if attribute_type == "TEXT":
            _invalid_payload()
        return _empty_statistics_values("UNKNOWN", published_cv_count)

    if kind != EXPECTED_KIND_BY_TYPE[attribute_type]:
        _invalid_payload()
    return STATISTICS_VALIDATORS[kind](statistics, published_cv_count)


def validate_external_payload(payload):
    _require_exact_keys(payload, {"position", "dataset", "attributes"})
    _require_exact_keys(payload["position"], {"id", "title"})
    _require_exact_keys(payload["dataset"], {"cvStatus", "publishedCvCount"})

    position_id = _require_positive_integer(payload["position"]["id"])
    title = _require_string(payload["position"]["title"], MAX_TITLE_LENGTH)
    if payload["dataset"]["cvStatus"] != "PUBLISHED":
        _invalid_payload()
    published_cv_count = _require_non_negative_integer(
        payload["dataset"]["publishedCvCount"]
    )
    attributes = payload["attributes"]
    if not isinstance(attributes, list) or len(attributes) > MAX_ATTRIBUTES:
        _invalid_payload()

    normalized_attributes = []
    seen_attribute_ids = set()
    for attribute in attributes:
        _require_exact_keys(
            attribute,
            {"id", "name", "type", "isRequired", "sortOrder", "statistics"},
        )
        attribute_id = _require_positive_integer(attribute["id"])
        if attribute_id in seen_attribute_ids:
            _invalid_payload()
        seen_attribute_ids.add(attribute_id)
        attribute_type = attribute["type"]
        if attribute_type not in ATTRIBUTE_TYPES:
            _invalid_payload()
        if not isinstance(attribute["isRequired"], bool):
            _invalid_payload()

        normalized_attribute = {
            "external_attribute_id": attribute_id,
            "title": _require_string(attribute["name"], MAX_TITLE_LENGTH),
            "attribute_type": attribute_type,
            "is_required": attribute["isRequired"],
            "sort_order": _require_non_negative_integer(attribute["sortOrder"]),
        }
        normalized_attribute.update(
            _validate_statistics(
                attribute_type,
                attribute["statistics"],
                published_cv_count,
            )
        )
        normalized_attributes.append(normalized_attribute)

    return {
        "external_position_id": position_id,
        "title": title,
        "cv_status": "PUBLISHED",
        "published_cv_count": published_cv_count,
        "attributes": normalized_attributes,
    }


class CvmsPosition(models.Model):
    _name = "cvms.position"
    _description = "Imported CVMS position statistics"
    _rec_name = "title"

    external_position_id = fields.Integer(required=True, readonly=True, index=True)
    title = fields.Char(required=True, readonly=True)
    cv_status = fields.Selection(
        [("PUBLISHED", "Published")],
        required=True,
        readonly=True,
        default="PUBLISHED",
    )
    published_cv_count = fields.Integer(required=True, readonly=True, default=0)
    imported_at = fields.Datetime(
        required=True,
        readonly=True,
        default=fields.Datetime.now,
    )
    attribute_ids = fields.One2many(
        "cvms.position.attribute",
        "position_id",
        readonly=True,
    )

    _external_position_id_unique = models.Constraint(
        "UNIQUE(external_position_id)",
        "The external CVMS position ID must be unique.",
    )

    @api.model
    def _sync_external_payload(self, payload):
        position_model = self.sudo()
        attribute_model = self.env["cvms.position.attribute"].sudo()
        popular_value_model = self.env[
            "cvms.position.attribute.popular.value"
        ].sudo()
        position = position_model.search(
            [("external_position_id", "=", payload["external_position_id"])],
            limit=1,
        )
        position_values = {
            "external_position_id": payload["external_position_id"],
            "title": payload["title"],
            "cv_status": payload["cv_status"],
            "published_cv_count": payload["published_cv_count"],
            "imported_at": fields.Datetime.now(),
        }
        if position:
            position.write(position_values)
        else:
            position = position_model.create(position_values)

        existing_attributes = attribute_model.search(
            [("position_id", "=", position.id)]
        )
        existing_by_external_id = {
            attribute.external_attribute_id: attribute
            for attribute in existing_attributes
        }
        imported_attribute_ids = set()

        for attribute_payload in payload["attributes"]:
            attribute_values = dict(attribute_payload)
            popular_values = attribute_values.pop("popular_values")
            external_attribute_id = attribute_values["external_attribute_id"]
            imported_attribute_ids.add(external_attribute_id)
            attribute_values["position_id"] = position.id
            attribute = existing_by_external_id.get(external_attribute_id)
            if attribute:
                attribute.write(attribute_values)
            else:
                attribute = attribute_model.create(attribute_values)

            attribute.popular_value_ids.sudo().unlink()
            if popular_values:
                popular_value_model.create(
                    [
                        {
                            "attribute_id": attribute.id,
                            "value": item["value"],
                            "count": item["count"],
                        }
                        for item in popular_values
                    ]
                )

        stale_attributes = existing_attributes.filtered(
            lambda attribute: attribute.external_attribute_id
            not in imported_attribute_ids
        )
        stale_attributes.sudo().unlink()
        return position


class CvmsPositionAttribute(models.Model):
    _name = "cvms.position.attribute"
    _description = "Imported CVMS position attribute statistics"
    _rec_name = "title"
    _order = "sort_order, id"

    position_id = fields.Many2one(
        "cvms.position",
        required=True,
        readonly=True,
        index=True,
        ondelete="cascade",
    )
    external_attribute_id = fields.Integer(required=True, readonly=True)
    title = fields.Char(required=True, readonly=True)
    attribute_type = fields.Char(required=True, readonly=True)
    is_required = fields.Boolean(readonly=True)
    sort_order = fields.Integer(readonly=True)
    statistics_kind = fields.Selection(
        [
            ("BOOLEAN", "Boolean"),
            ("NUMERIC", "Numeric"),
            ("POPULAR_VALUES", "Popular Values"),
            ("DATE_RANGE", "Date Range"),
            ("PERIOD_RANGE", "Period Range"),
            ("COMPLETENESS", "Completeness"),
            ("UNKNOWN", "Unknown"),
        ],
        readonly=True,
    )
    filled_count = fields.Integer(readonly=True, default=0)
    missing_count = fields.Integer(readonly=True, default=0)
    true_count = fields.Integer(readonly=True, default=0)
    false_count = fields.Integer(readonly=True, default=0)
    average_value = fields.Float(readonly=True)
    minimum_value = fields.Float(readonly=True)
    maximum_value = fields.Float(readonly=True)
    earliest_date = fields.Date(
        string="Earliest Date",
        help="Earliest populated date returned by CVMS date range statistics.",
        readonly=True,
    )
    latest_date = fields.Date(
        string="Latest Date",
        help="Latest populated date returned by CVMS date range statistics.",
        readonly=True,
    )
    earliest_period_start = fields.Date(
        string="Earliest Period Start",
        help="Earliest populated period start returned by CVMS period range statistics.",
        readonly=True,
    )
    latest_period_end = fields.Date(
        string="Latest Period End",
        help="Latest populated period end returned by CVMS period range statistics.",
        readonly=True,
    )
    popular_value_ids = fields.One2many(
        "cvms.position.attribute.popular.value",
        "attribute_id",
        readonly=True,
    )

    _position_external_attribute_id_unique = models.Constraint(
        "UNIQUE(position_id, external_attribute_id)",
        "The external attribute ID must be unique within a position.",
    )


class CvmsPositionAttributePopularValue(models.Model):
    _name = "cvms.position.attribute.popular.value"
    _description = "Imported CVMS popular attribute value"
    _rec_name = "value"
    _order = "count desc, value, id"

    attribute_id = fields.Many2one(
        "cvms.position.attribute",
        required=True,
        readonly=True,
        index=True,
        ondelete="cascade",
    )
    value = fields.Char(required=True, readonly=True)
    count = fields.Integer(required=True, readonly=True, default=0)

    _attribute_value_unique = models.Constraint(
        "UNIQUE(attribute_id, value)",
        "Popular values must be unique within an attribute.",
    )
