import { describe, test, expect } from '@jest/globals';
import { PromptEngine } from '../src/core/prompt-engine.js';
import { wsBridge } from '../src/core/ws-bridge.js';

describe('PromptEngine', () => {
    test('Macro Substitution', () => {
        const template = 'Hello {{user}}! I am {{char}}, also known as {{CHAR}}. The scenario is {{scenario}}.';
        const vars = { user: 'Alice', char: 'Bob', scenario: 'Medieval Castle' };
        const substituted = PromptEngine.substituteMacros(template, vars);
        expect(substituted).toContain('Hello Alice!');
        expect(substituted).toContain('I am Bob');
        expect(substituted).toContain('BOB');
        expect(substituted).toContain('Medieval Castle');
    });

    test('Prompt Assembly with Token Budget', () => {
        const result = PromptEngine.assemble({
            character: {
                name: 'CyberSage',
                description: 'An AI mentor in Neo-Tokyo.',
                personality: 'Calm, analytical.',
                scenario: 'Neon-lit alley.',
            },
            user: {
                name: 'NetRunner',
                persona: 'A skilled hacker.',
            },
            systemPrompt: 'You are {{char}}. Act in character.',
            worldInfoBefore: 'World Rule: Cyberspace connects all.',
            depthPrompts: [
                { depth: 1, role: 'system', content: '[Current Situation: High Alert]' },
            ],
            messages: [
                { is_user: true, mes: 'Can you decrypt this shard?' },
                { is_user: false, mes: 'I can try, but the ICE is thick.' },
                { is_user: true, mes: 'Take all the time you need.' },
            ],
            options: {
                maxContextTokens: 2000,
                maxResponseTokens: 200,
            },
        });

        expect(Array.isArray(result.messages)).toBe(true);
        expect(result.messages.length).toBeGreaterThanOrEqual(4);
        const sysMsg = result.messages[0];
        expect(sysMsg.role).toBe('system');
        expect(sysMsg.content).toContain('CyberSage');
        expect(sysMsg.content).toContain('World Rule: Cyberspace');

        const depthMsg = result.messages.find(m => m.content && m.content.includes('High Alert'));
        expect(depthMsg).toBeDefined();
    });

    test('Budget Truncation (Older messages pruned)', () => {
        const manyMessages = [];
        for (let i = 0; i < 20; i++) {
            manyMessages.push({ is_user: true, mes: `Message #${i}: ` + 'X'.repeat(300) });
        }
        const budgetResult = PromptEngine.assemble({
            character: { name: 'Bot' },
            user: { name: 'User' },
            messages: manyMessages,
            options: {
                maxContextTokens: 600,
                maxResponseTokens: 100,
            },
        });
        expect(budgetResult.stats.messagesIncluded).toBeLessThan(20);
        expect(budgetResult.stats.messagesIncluded).toBeGreaterThan(0);
    });

    test('Safe Interception Fallback when Bridge has no client', async () => {
        const initialPrompt = PromptEngine.assemble({
            character: { name: 'Assistant' },
            user: { name: 'User' },
            messages: [{ is_user: true, mes: 'Tell me a secret.' }],
        });

        const intercepted = await wsBridge.requestInterception(
            'default',
            'CHAT_COMPLETION_PROMPT_READY',
            { chat: initialPrompt.messages },
            500,
        );

        // When no client is connected, payload is returned unmodified without error
        expect(intercepted.chat).toEqual(initialPrompt.messages);
    });
});
