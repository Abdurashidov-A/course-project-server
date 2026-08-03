{
    "name": "CVMS Position Statistics",
    "version": "19.0.1.3.0",
    "category": "Human Resources",
    "summary": "Read-only viewer for imported CVMS position statistics",
    "depends": ["base"],
    "external_dependencies": {"python": ["requests"]},
    "data": [
        "security/ir.model.access.csv",
        "views/position_views.xml",
        "views/import_position_wizard_views.xml",
    ],
    "application": True,
    "installable": True,
    "license": "LGPL-3",
}
