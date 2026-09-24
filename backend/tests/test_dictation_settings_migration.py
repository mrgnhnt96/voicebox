"""Existing installs retain their settings when microphone options are added."""

from sqlalchemy import create_engine, inspect, text

from backend.database.migrations import _migrate_capture_settings
from backend.models import CaptureSettingsUpdate


def test_microphone_migration_preserves_existing_settings_and_is_idempotent():
    engine = create_engine('sqlite:///:memory:')
    with engine.begin() as connection:
        connection.execute(text('CREATE TABLE capture_settings (id INTEGER PRIMARY KEY, auto_refine BOOLEAN)'))
        connection.execute(text('INSERT INTO capture_settings VALUES (1, 0)'))
    for _ in range(2):
        _migrate_capture_settings(engine, inspect(engine), {'capture_settings'})
    with engine.begin() as connection:
        row = connection.execute(text(
            'SELECT auto_refine, input_device_id FROM capture_settings WHERE id = 1'
        )).one()
        assert tuple(row) == (0, None)
        connection.execute(text("UPDATE capture_settings SET input_device_id = 'usb'"))
    _migrate_capture_settings(engine, inspect(engine), {'capture_settings'})
    with engine.connect() as connection:
        assert tuple(connection.execute(text(
            'SELECT auto_refine, input_device_id FROM capture_settings WHERE id = 1'
        )).one()) == (0, 'usb')


def test_resetting_microphone_is_distinct_from_omitting_the_setting():
    assert CaptureSettingsUpdate().model_dump(exclude_unset=True) == {}
    assert CaptureSettingsUpdate(input_device_id=None).model_dump(exclude_unset=True) == {'input_device_id': None}
