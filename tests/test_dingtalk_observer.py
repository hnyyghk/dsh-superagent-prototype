"""Offline readback fixtures; these tests never start DWS or send a message."""
from pathlib import Path
import runpy
import unittest

observer = runpy.run_path(str(Path(__file__).resolve().parents[1] /
    "skills/dsh-superagent-dingtalk/scripts/observe.py"))
layers = observer["response_layers"]


def confirmed(receipt):
    return observer["task_confirmed"](layers(receipt), "t", "g", "m")


def readback(page):
    return observer["group_readback"](layers(page), "m", "g", "self", "MARK")


class Readback(unittest.TestCase):
    def test_flat_and_nested_terminal_receipts(self):
        self.assertTrue(confirmed({"messageId": "m", "conversationId": "g", "deliveryStatus": "delivered"}))
        self.assertTrue(confirmed({"openTaskId": "t", "messageRef": {"openMessageId": "m"},
                                   "result": {"openMessageId": "m", "openConversationId": "g", "sendStatus": "SUCCESS"}}))

    def test_acceptance_and_conflicting_identifiers_are_not_delivery(self):
        receipt = {"openMessageId": "m", "openConversationId": "g", "sendStatus": "SUCCESS"}
        for result in ({"openTaskId": "t"}, {**receipt, "sendStatus": "PENDING"},
                       {"openTaskId": "other", "result": receipt}, {**receipt, "openConversationId": "other"},
                       {"messageRef": {"openMessageId": "different"}, "result": receipt}):
            with self.subTest(result=result):
                self.assertFalse(confirmed(result))

    def test_original_group_sender_and_marker_must_be_on_the_same_message(self):
        msg = {"messageId": "m", "conversationId": "g", "senderId": "self", "text": "MARK"}
        alt = {"openMessageId": "m", "openConversationId": "g", "senderId": "self", "content": "MARK"}
        self.assertEqual(readback({"messages": [msg]}), (True, True))
        self.assertEqual(readback({"data": {"result": {"messages": [alt]}}}), (True, True))
        for change in ({"senderId": "other"}, {"conversationId": "other"}, {"messageId": "other"}):
            self.assertEqual(readback({"messages": [{**msg, **change}]}), (False, False))
        self.assertEqual(readback({"messages": [{**msg, "text": ""}, {**msg, "messageId": "elsewhere"}]}), (True, False))

    def test_partial_and_failed_reads_are_not_delivery_evidence(self):
        for value in ({"ok": True, "result": {"success": False}},
                      {"data": {"messagesComplete": False, "messages": []}}):
            with self.assertRaises(ValueError):
                layers(value)


if __name__ == "__main__":
    unittest.main()
