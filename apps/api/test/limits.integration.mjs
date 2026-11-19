import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import express from 'express';
import { createClient } from 'redis';
import { createLimiters } from '../dist/limits/index.js';

const redisUrl = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL;
if (!redisUrl) throw new Error('Set TEST_REDIS_URL or REDIS_URL to a development Redis instance.');

test('two API instances share Redis account counters and fail closed on outage', async () => {
  const clients = [0, 1].map(() => createClient({ url: redisUrl,
    socket: { connectTimeout: 5_000, reconnectStrategy: false },
  }));
  for (const client of clients) { client.on('error', () => {}); await client.connect(); }
  const servers = [];
  const email = `phase07-${randomBytes(8).toString('hex')}@example.invalid`;
  try {
    for (let i = 0; i < 2; i++) {
      const app = express();
      app.use(express.json());
      app.post('/login', createLimiters({ redis: { sendCommand: command => clients[i].sendCommand(command) } }).loginAccount,
        (_req, res) => res.json({ ok: true }));
      const server = createServer(app);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      servers.push(server);
    }
    const post = async server => fetch(`http://127.0.0.1:${server.address().port}/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }),
    });
    for (let i = 0; i < 5; i++) assert.equal((await post(servers[i % 2])).status, 200);
    const blocked = await post(servers[1]);
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers.get('retry-after'));
    clients[0].destroy();
    assert.equal((await post(servers[0])).status, 503);
  } finally {
    for (const server of servers) await new Promise(resolve => server.close(resolve));
    for (const client of clients) if (client.isOpen) await client.close();
  }
});
