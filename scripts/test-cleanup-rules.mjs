import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { updateMessageReadState, updateMessageStarState } from '../worker/email-store.js'
import { executeCleanupRule } from '../worker/mail-governance-executor.js'

function sqliteEnv(db, beforeRun = () => {}) {
  return { DB: { prepare(sql) {
    const execute = (params) => {
      assert.ok(params.length <= 100, `D1 parameter limit exceeded: ${params.length}`)
      const statement = db.prepare(sql)
      return {
        async first() { return statement.get(...params) },
        async all() { return { results: statement.all(...params) } },
        async run() {
          beforeRun(sql)
          return { meta: { changes: statement.run(...params).changes } }
        },
      }
    }
    return { bind: (...params) => execute(params), ...execute([]) }
  } } }
}

for (const matchCount of [0, 100, 101, 200, 251]) {
  for (const batchSize of [undefined, 1000, 37, 0]) {
    test(`cleanup ${matchCount} matches with batchSize=${batchSize}`, async () => {
      const db = new DatabaseSync(':memory:')
      try {
        db.exec(`CREATE TABLE emails (
          id INTEGER PRIMARY KEY, recipient TEXT, sender TEXT, subject TEXT,
          received_at TEXT, is_starred INTEGER
        )`)
        const insert = db.prepare('INSERT INTO emails VALUES (?, ?, ?, ?, ?, ?)')
        const subject = 'Try Grok Bot free for 3 days'
        for (let id = 1; id <= matchCount; id++) {
          insert.run(id, 'test@example.com', 'GrokBot', subject, '2026-09-17', 0)
        }
        const protectedRows = [
          ['test@example.com', 'GrokBot', subject, 1],
          ['other@example.com', 'GrokBot', subject, 0],
          ['test@example.com', 'Other', subject, 0],
          ['test@example.com', 'GrokBot', 'Other subject', 0],
        ]
        protectedRows.forEach(([recipient, sender, title, starred], index) => {
          insert.run(matchCount + index + 1, recipient, sender, title, '2026-09-17', starred)
        })
        const env = sqliteEnv(db)
        const result = await executeCleanupRule(env, {
          name: 'GrokBot',
          recipient: 'test@example.com',
          sender_contains: 'GrokBot',
          subject_contains: subject,
        }, { batchSize, persistRuleStatus: false })
        assert.equal(result.match_count, matchCount)
        assert.equal(result.deleted_count, matchCount)
        assert.equal(result.error, '')
        assert.deepEqual(
          db.prepare('SELECT id FROM emails ORDER BY id').all().map((row) => row.id),
          protectedRows.map((_, index) => matchCount + index + 1)
        )
      } finally {
        db.close()
      }
    })
  }
}

for (const field of ['sender', 'subject']) {
  for (const literal of ['%', '_', String.fromCharCode(92)]) {
    test(`cleanup treats ${field} ${literal} literally`, async () => {
      const db = new DatabaseSync(':memory:')
      try {
        db.exec('CREATE TABLE emails (id INTEGER PRIMARY KEY, sender TEXT, subject TEXT, received_at TEXT, is_starred INTEGER)')
        const insert = db.prepare('INSERT INTO emails VALUES (?, ?, ?, ?, 0)')
        insert.run(1, `a${literal}b`, `a${literal}b`, '2026-09-17')
        insert.run(2, 'axb', 'axb', '2026-09-17')
        const result = await executeCleanupRule(sqliteEnv(db), {
          name: 'literal', [`${field}_contains`]: literal,
        }, { persistRuleStatus: false })
        assert.equal(result.deleted_count, 1)
        assert.deepEqual(db.prepare('SELECT id FROM emails').all().map(row => row.id), [2])
      } finally { db.close() }
    })
  }
}

test('cleanup counts only rows it actually deleted', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec("CREATE TABLE emails (id INTEGER PRIMARY KEY, subject TEXT, received_at TEXT, is_starred INTEGER); INSERT INTO emails VALUES (1, 'match', '2026-09-17', 0), (2, 'match', '2026-09-17', 0)")
    const env = sqliteEnv(db, sql => {
      if (sql.startsWith('DELETE')) db.exec('DELETE FROM emails WHERE id = 1')
    })
    const result = await executeCleanupRule(env, { name: 'count', subject_contains: 'match' }, { persistRuleStatus: false })
    assert.equal(result.match_count, 2)
    assert.equal(result.deleted_count, 1)
  } finally { db.close() }
})

for (const update of [updateMessageReadState, updateMessageStarState]) {
  test(`${update.name} accepts 100 IDs within D1 limits`, async () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec('CREATE TABLE emails (id INTEGER PRIMARY KEY, is_read INTEGER DEFAULT 0, is_starred INTEGER DEFAULT 0)')
      const ids = Array.from({ length: 100 }, (_, i) => i + 1)
      ids.forEach(id => db.prepare('INSERT INTO emails (id) VALUES (?)').run(id))
      const env = sqliteEnv(db)
      for (const value of [true, false]) {
        assert.equal((await update(env, ids, value)).meta.changes, 100)
        const column = update === updateMessageReadState ? 'is_read' : 'is_starred'
        assert.equal(db.prepare(`SELECT SUM(${column}) AS total FROM emails`).get().total, value ? 100 : 0)
      }
    } finally { db.close() }
  })
}
