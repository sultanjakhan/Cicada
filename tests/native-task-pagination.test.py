"""Portable check of the exact native SQL plus the shipped MCP client (stdlib)."""
import importlib.util
import pathlib
import re
import sqlite3
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'src-tauri/src/agent_access.rs').read_text()
SQL = re.search(r'const PERSONAL_PAGE_SQL: &str = r#"(.*?)"#;', SOURCE, re.S)[1]
LEGACY = re.search(r'conn.prepare\("(SELECT id FROM items .*?LIMIT 101)"\)', SOURCE)[1]
SPEC = importlib.util.spec_from_file_location('pagination_mcp', ROOT / 'plugins/cicada-tasks/cicada-local-tasks-0.5.0/vendor/agent_mcp.py')
mcp = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mcp)

class Bridge:
    def __init__(self): self.calls = []
    def call(self, value): self.calls.append(value); return value

class Pagination(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.execute('CREATE TABLE items(id TEXT PRIMARY KEY, kind TEXT, archived INTEGER, tags TEXT, updated_at TEXT)')
        self.ids = [f'task-{n:04}' for n in range(137)]
        for n, identity in enumerate(reversed(self.ids)):
            self.db.execute('INSERT INTO items VALUES(?,?,?,?,?)', (identity, 'task', 0, 'task-sphere:personal', str(n % 7)))
        self.db.execute('UPDATE items SET tags=? WHERE id=?', ('\t\u2003task-sphere:personal\u3000', self.ids[0]))
        for n, (kind, archived, tags) in enumerate([
            ('task',0,'task-sphere:work'), ('task',1,'task-sphere:personal'),
            ('note',0,'task-sphere:personal'), ('task',0,'task-sphere:personal, JIRA:1'),
            ('task',0,'task-sphere:personal,Investlink:x'), ('task',0,'task-sphere:personal,\t task-sphere:work\u2003')]):
            self.db.execute('INSERT INTO items VALUES(?,?,?,?,?)', (f'private-{n}', kind, archived, tags, '999'))
    def test_complete_bounded_readonly_traversal(self):
        before = '\n'.join(self.db.iterdump())
        for size in (1, 17, 100):
            after, seen = '', []
            while True:
                rows = [r[0] for r in self.db.execute(SQL, (after, size + 1))]
                seen.extend(rows[:size])
                self.assertLessEqual(len(rows), size + 1)
                if len(rows) <= size: break
                after = rows[size-1]
                # Mutable timestamps must not disturb keyset order.
                self.db.execute('UPDATE items SET updated_at=updated_at')
            self.assertEqual(seen, self.ids)
            self.assertEqual(len(set(seen)), 137)
        self.assertEqual(before, '\n'.join(self.db.iterdump()))
    def test_empty_and_legacy(self):
        self.assertEqual(len(self.db.execute(LEGACY).fetchall()),101)
        self.assertEqual(self.db.execute(SQL,('zzz',101)).fetchall(),[])
        b=Bridge();mcp.invoke('cicada',b,'cicada_list_tasks',{})
        self.assertEqual(b.calls[0]['body'],{})
        self.assertEqual(b.calls[0]['action'],'list')
    def test_client_schema_forwarding_and_rejection(self):
        definition=next(t for t in mcp.tools_for('cicada') if t['name']=='cicada_list_tasks')
        self.assertEqual(definition['inputSchema']['required'],[])
        args={'pageSize':17,'cursor':'v1:'+b'task-0016'.hex()}
        b=Bridge();mcp.invoke('cicada',b,'cicada_list_tasks',args)
        self.assertEqual(b.calls[-1]['body'],args)
        for args in ({'pageSize':0},{'pageSize':101},{'pageSize':True},{'pageSize':1.5},{'cursor':None},{'cursor':'v1:00'},{'cursor':'v1:AA'},{'cursor':'v1:7'},{'cursor':'v1:'+'61'*81},{'extra':1}):
            with self.assertRaises(ValueError):mcp.invoke('cicada',b,'cicada_list_tasks',args)
        self.assertEqual(len(b.calls),1)

if __name__=='__main__': unittest.main(verbosity=2)
