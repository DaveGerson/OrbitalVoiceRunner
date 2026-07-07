import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import notetype  # noqa: E402
import dispatch  # noqa: E402

# The exact closed set the classifier may emit (a SUBSET of NoteType in src/store/types.ts — it must
# NEVER emit "handoff", which would corrupt the typed-note taxonomy hwu.4/hwu.5 build on).
ALLOWED = {"decision", "todo", "warning", "note"}


class ClassifyNoteTest(unittest.TestCase):
    def test_decision_phrasings(self):
        for text in [
            "We decided to use Postgres for the ledger.",
            "Decision: go with the circular buffer.",
            "Let's go with option B for the seam.",
            "We agreed to ship the flag off by default.",
        ]:
            self.assertEqual(notetype.classify_note(text), "decision", text)

    def test_todo_phrasings(self):
        for text in [
            "TODO: rotate the API keys before launch.",
            "Remember to update the changelog.",
            "We need to add a retry to the uploader.",
            "Follow up with the design lane about the chip.",
        ]:
            self.assertEqual(notetype.classify_note(text), "todo", text)

    def test_warning_phrasings(self):
        for text in [
            "Warning: the migration drops the column.",
            "Be careful, the build is failing on CI.",
            "This is risky and could regress the voice path.",
            "Heads up, the token endpoint is broken.",
        ]:
            self.assertEqual(notetype.classify_note(text), "warning", text)

    def test_default_note_phrasings(self):
        for text in [
            "The kitchen pass renders on the right sidebar.",
            "Postgres connection pooling uses PgBouncer here.",
            "The operator asked how the earcons sound.",
        ]:
            self.assertEqual(notetype.classify_note(text), "note", text)

    def test_empty_text_is_note(self):
        self.assertEqual(notetype.classify_note(""), "note")
        self.assertEqual(notetype.classify_note("    "), "note")

    def test_non_string_is_note(self):
        self.assertEqual(notetype.classify_note(None), "note")
        self.assertEqual(notetype.classify_note(42), "note")

    def test_never_emits_handoff_or_out_of_set(self):
        for text in ["hand this off to the other pane", "handoff the build", "decided", "TODO", "danger"]:
            self.assertIn(notetype.classify_note(text), ALLOWED, text)

    def test_determinism_same_input_same_type(self):
        text = "We need to be careful: the migration is risky."
        first = notetype.classify_note(text)
        for _ in range(10):
            self.assertEqual(notetype.classify_note(text), first)

    def test_precedence_warning_over_todo(self):
        # "need to" (todo cue) AND "broken"/"risky" (warning cue) -> warning wins (hazards are highest signal).
        self.assertEqual(notetype.classify_note("We need to fix the broken build."), "warning")


class DispatchNoteClassifyOpTest(unittest.TestCase):
    def test_note_classify_op_routes_and_wraps(self):
        resp = dispatch.handle({"id": "1", "v": dispatch.WIRE_VERSION, "op": "note.classify",
                                "text": "Decision: use the circular buffer."})
        self.assertTrue(resp["ok"])
        self.assertEqual(resp["type"], "decision")

    def test_note_classify_op_bad_payload_fails_closed(self):
        # A missing required field surfaces as ok:False NOTETYPE_FAILED (never crashes the daemon).
        resp = dispatch.handle({"id": "2", "v": dispatch.WIRE_VERSION, "op": "note.classify"})
        self.assertFalse(resp["ok"])
        self.assertEqual(resp["error"]["code"], "NOTETYPE_FAILED")


if __name__ == "__main__":
    unittest.main()
