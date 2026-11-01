import pytest

from tools.clip_labeler.server import safe_name, validate_annotations


def test_safe_name_preserves_readable_speaker_labels():
    assert safe_name("Seat 03 - Alice") == "Seat_03_-_Alice"


def test_safe_name_rejects_path_traversal():
    with pytest.raises(ValueError):
        safe_name("../../")


def test_annotation_validation_normalizes_values():
    result = validate_annotations(
        [
            {
                "id": "a1",
                "start": 1.23456,
                "end": 8.76543,
                "speaker": "Alice",
                "flag": "clean",
                "included": True,
                "notes": "Clear response",
            }
        ]
    )
    assert result[0]["start"] == 1.235
    assert result[0]["end"] == 8.765
    assert result[0]["speaker"] == "Alice"


def test_annotation_validation_rejects_bad_ranges():
    with pytest.raises(ValueError):
        validate_annotations(
            [{"start": 8, "end": 7, "speaker": "Alice", "flag": "clean"}]
        )
