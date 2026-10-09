import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SessionManager, SESSION_IDLE_MS, MAX_SESSIONS_PER_USER } from '../src/transport.js';

const factory = () => new McpServer({ name: 't', version: '0' }, { capabilities: { tools: {} } });

describe('SessionManager memory bounds', () => {
    it('closes sessions idle longer than SESSION_IDLE_MS', async () => {
        let now = 1_000_000;
        const sm = new SessionManager(factory, () => now);
        const idle = await sm.create('alice');
        now += SESSION_IDLE_MS / 2;
        const active = await sm.create('bob');
        now += SESSION_IDLE_MS / 2 + 1;
        sm.sweep();
        expect(sm.get(idle.sessionId)).toBeUndefined();
        expect(sm.get(active.sessionId)).toBeDefined();
    });

    it('caps sessions per user, closing the least recently used', async () => {
        let now = 1_000_000;
        const sm = new SessionManager(factory, () => now++);
        const first = await sm.create('alice');
        for (let i = 1; i < MAX_SESSIONS_PER_USER; i++) await sm.create('alice');
        await sm.create('bob');
        expect(sm.size).toBe(MAX_SESSIONS_PER_USER + 1);
        await sm.create('alice');
        expect(sm.size).toBe(MAX_SESSIONS_PER_USER + 1);
        expect(sm.get(first.sessionId)).toBeUndefined();
    });
});
