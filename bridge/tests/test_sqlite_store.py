import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sqlite_store import SQLiteStore


class SQLiteStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = SQLiteStore(os.path.join(self.tmp.name, 'lava.sqlite3'))

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def test_transactional_documents_and_queries(self):
        rows = [{'key': 'FINAL|EQ-1|0', 'station': 'FINAL', 'state': 'pass', 'sn': 'SN-1'},
                {'key': 'FINAL|EQ-1|1', 'station': 'FINAL', 'state': 'testing', 'sn': 'SN-2'}]
        self.assertEqual(self.store.execute({'action': 'putMany', 'store': 'slots', 'records': rows}), 2)
        self.assertEqual(self.store.execute({'action': 'count', 'store': 'slots'}), 2)
        result = self.store.execute({'action': 'query', 'store': 'slots',
                                     'filter': {'index': 'station', 'value': 'FINAL'}, 'opts': {}})
        self.assertEqual({r['sn'] for r in result}, {'SN-1', 'SN-2'})
        self.assertEqual(self.store.execute({'action': 'ledgerMark', 'store': 'ledger', 'keys': ['a', 'a']}), 1)
        self.assertEqual(self.store.execute({'action': 'ledgerFilter', 'store': 'ledger', 'keys': ['a', 'b']}), ['a'])

    def test_invalid_store_and_payload_are_rejected(self):
        with self.assertRaises(ValueError):
            self.store.execute({'action': 'query', 'store': 'unknown'})
        with self.assertRaises(ValueError):
            self.store.execute({'action': 'putMany', 'store': 'slots', 'records': [{'bad': 1}]})


if __name__ == '__main__':
    unittest.main()
