import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect } from '@jest/globals';
import {
    PromptAssembler,
    DualTrackTokenizer,
    PromptDiffAsserter,
} from '../src/core/prompt/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'prompt-parity');

function loadFixture(filename) {
    const filePath = path.join(FIXTURES_DIR, filename);
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

describe('Prompt Parity Phase 1: 8 Golden Fixture Differential Tests', () => {
    test('GF-PROMPT-01: Standard single character chat with base prompts and normal budget', async () => {
        const fixture = loadFixture('GF-PROMPT-01-standard-chat.json');
        const output = await PromptAssembler.assemble(fixture.input);
        expect(() => PromptDiffAsserter.assertPromptParity(output, fixture.expectedOutput)).not.toThrow();
        expect(output.chat.length).toBe(11);
        expect(output.metadata.tokensUsed).toBe(119);
    });

    test('GF-PROMPT-02: Author\'s Note and Summary relative injection to main slot', async () => {
        const fixture = loadFixture('GF-PROMPT-02-relative-injection.json');
        const output = await PromptAssembler.assemble(fixture.input);
        expect(() => PromptDiffAsserter.assertPromptParity(output, fixture.expectedOutput)).not.toThrow();
        expect(output.chat[0].content).toContain('Style Directive');
        expect(output.chat[1].content).toBe('You are the Archivist.');
        expect(output.chat[2].content).toContain('Summary');
    });

    test('GF-PROMPT-03: Multi-tier absolute depth and priority order injections', async () => {
        const fixture = loadFixture('GF-PROMPT-03-absolute-depth-order.json');
        const output = await PromptAssembler.assemble(fixture.input);
        expect(() => PromptDiffAsserter.assertPromptParity(output, fixture.expectedOutput)).not.toThrow();
        expect(output.metadata.injectedPromptsCount).toBe(4);
        expect(output.chat[output.chat.length - 1].content).toBe('Depth 0 system prompt');
    });

    test('GF-PROMPT-04: Strict budget exhaustion reverse sliding window truncation threshold', async () => {
        const fixture = loadFixture('GF-PROMPT-04-budget-exhaustion.json');
        const output = await PromptAssembler.assemble(fixture.input);
        expect(() => PromptDiffAsserter.assertPromptParity(output, fixture.expectedOutput)).not.toThrow();
        expect(output.metadata.droppedHistoryCount).toBe(2);
        expect(output.chat.length).toBe(4);
    });

    test('GF-PROMPT-05: Squash system messages with newline and whitelist protection', async () => {
        const fixture = loadFixture('GF-PROMPT-05-squash-system-messages.json');
        const output = await PromptAssembler.assemble(fixture.input);
        expect(() => PromptDiffAsserter.assertPromptParity(output, fixture.expectedOutput)).not.toThrow();
        expect(output.metadata.squashedCount).toBe(1);
        expect(output.chat[0].content).toBe('Instruction 1: Be concise.\nInstruction 2: Be accurate.');
        expect(output.chat[1].name).toBe('Narrator');
    });

    test('GF-PROMPT-06: Function tools schema reservation and tool calls/results reasoning pairing', async () => {
        const fixture = loadFixture('GF-PROMPT-06-tools-and-reasoning.json');
        const output = await PromptAssembler.assemble(fixture.input);
        expect(() => PromptDiffAsserter.assertPromptParity(output, fixture.expectedOutput)).not.toThrow();
        expect(output.metadata.reservedTokens.tools).toBe(20);
        expect(output.chat[3].tool_calls).toBeDefined();
        expect(output.chat[4].role).toBe('tool');
        expect(output.chat[4].tool_call_id).toBe('call_987');
    });

    test('GF-PROMPT-07: Continue mode prefill displacement and quiet prompt reservation', async () => {
        const fixture = loadFixture('GF-PROMPT-07-continue-impersonate-quiet.json');
        const output = await PromptAssembler.assemble(fixture.input);
        expect(() => PromptDiffAsserter.assertPromptParity(output, fixture.expectedOutput)).not.toThrow();
        expect(output.metadata.reservedTokens.controlPrompts).toBe(24);
        expect(output.chat[4].content).toContain('[Continue thought: Seraphina]');
    });

    test('GF-PROMPT-08: Multimodal inline media formatting and provider dialect transforms', async () => {
        const fixture = loadFixture('GF-PROMPT-08-multimodal-and-provider-transforms.json');
        const output = await PromptAssembler.assemble(fixture.input);
        expect(() => PromptDiffAsserter.assertPromptParity(output, fixture.expectedOutput)).not.toThrow();
        expect(Array.isArray(output.chat[2].content)).toBe(true);
        expect(output.chat[2].content[1].type).toBe('image_url');
        expect(output.providerTransforms?.claude).toBeDefined();
    });

    test('Browser-shaped contexts preserve the explicit PromptManager order', async () => {
        const fixture = loadFixture('GF-PROMPT-01-standard-chat.json');
        const input = structuredClone(fixture.input);
        input.promptOrder = [
            'main',
            'charDescription',
            'worldInfoBefore',
            'worldInfoAfter',
            'charPersonality',
            'scenario',
            'personaDescription',
        ];

        const output = await PromptAssembler.assemble(input);

        expect(output.chat.slice(0, 7).map((message) => message.content)).toEqual([
            'You are Seraphina.',
            'Seraphina is a master artificer of clockwork machines.',
            'Eldoria is powered by arcane brass gears.',
            'The Grand Regulator maintains temporal synchronization.',
            '[Personality: Curious, meticulous, and articulate.]',
            '[Scenario: The clocktower workshop on a rainy afternoon.]',
            'Alice is a wandering scholar.',
        ]);
    });

    test('Browser-shaped contexts can place an active custom prompt in the declared order', async () => {
        const fixture = loadFixture('GF-PROMPT-01-standard-chat.json');
        const input = structuredClone(fixture.input);
        input.prompts = [{
            identifier: 'customDirective',
            role: 'system',
            content: 'Answer with precise measurements.',
        }];
        input.promptOrder = ['main', 'customDirective', 'charDescription'];
        input.recordedTokenCounts.customDirective = 4;

        const output = await PromptAssembler.assemble(input);

        expect(output.chat.slice(0, 3).map((message) => message.content)).toEqual([
            'You are Seraphina.',
            'Answer with precise measurements.',
            'Seraphina is a master artificer of clockwork machines.',
        ]);
    });

    test('Explicit prompt order does not resurrect a disabled browser prompt', async () => {
        const fixture = loadFixture('GF-PROMPT-01-standard-chat.json');
        const input = structuredClone(fixture.input);
        input.promptOrder = ['main', 'chatHistory'];
        input.recordedTokenCounts = {
            main: 6,
            newMainChat: 5,
            'chatHistory-1': 14,
            'chatHistory-2': 16,
            'chatHistory-3': 11,
        };

        const output = await PromptAssembler.assemble(input);

        expect(output.chat.map((message) => message.content)).not.toContain('Seraphina is a master artificer of clockwork machines.');
        expect(output.chat.map((message) => message.content)).toContain('You are Seraphina.');
    });
});

describe('Prompt Parity: Dual-Track Tokenizer & Fail-Closed Guardrails', () => {
    test('Track A: Returns recorded token count when present', () => {
        const tokenizer = new DualTrackTokenizer({
            recordedTokenCounts: {
                'msg-key-1': 42,
            },
        });
        expect(tokenizer.countSync({}, 'msg-key-1')).toBe(42);
    });

    test('Track B: Uses true model tokenizer instance when provided', () => {
        const customTokenizer = {
            count: (item) => String(item.content).split(/\s+/).length,
        };
        const tokenizer = new DualTrackTokenizer({
            tokenizer: customTokenizer,
        });
        expect(tokenizer.countSync({ content: 'three word prompt' })).toBe(3);
    });

    test('Fail-Closed: Throws explicit error when count is missing and no tokenizer available', () => {
        const tokenizer = new DualTrackTokenizer({
            recordedTokenCounts: {},
        });
        expect(() => tokenizer.countSync({ role: 'user', content: 'unrecorded content' }, 'unknown-id'))
            .toThrow(/\[DualTrackTokenizer\] Fail-Closed: No recorded token count found/);
    });
});

describe('Prompt Parity: CHAT_COMPLETION_PROMPT_READY Mutable In-Place Hook Contract', () => {
    test('Preserves in-place mutations executed by plugin hook', async () => {
        const fixture = loadFixture('GF-PROMPT-01-standard-chat.json');

        const hook = async ({ chat, dryRun }) => {
            expect(dryRun).toBe(false);
            // In-place mutation: modify first element and append a new message
            chat[0].content = 'MUTATED_BY_PLUGIN';
            chat.push({
                role: 'system',
                content: 'INJECTED_AT_READY_HOOK',
            });
        };

        const output = await PromptAssembler.assemble(fixture.input, {
            pluginReadyHook: hook,
        });

        expect(output.chat[0].content).toBe('MUTATED_BY_PLUGIN');
        expect(output.chat[output.chat.length - 1].content).toBe('INJECTED_AT_READY_HOOK');
    });
});

describe('Prompt Parity: 8 Golden Differential Assertion Invariants', () => {
    const validActual = {
        chat: [
            { role: 'system', content: 'Prompt A' },
            { role: 'user', content: 'Prompt B' },
        ],
        metadata: {
            totalBudget: 1000,
            tokensUsed: 50,
            remainingTokens: 950,
            reservedTokens: { replyPriming: 3 },
            droppedHistoryCount: 0,
            squashedCount: 0,
            injectedPromptsCount: 0,
        },
    };

    test('Invariant 1: Message count mismatch triggers error', () => {
        const mismatched = { ...validActual, chat: [validActual.chat[0]] };
        expect(() => PromptDiffAsserter.assertMessageCountAndTruncation(mismatched, validActual))
            .toThrow(/Assertion 1 Failed: Message Count Invariant/);
    });

    test('Invariant 2: Role sequence mismatch triggers error', () => {
        const mismatched = {
            ...validActual,
            chat: [
                { role: 'user', content: 'Prompt A' },
                { role: 'user', content: 'Prompt B' },
            ],
        };
        expect(() => PromptDiffAsserter.assertRoleSequence(mismatched, validActual))
            .toThrow(/Assertion 2 Failed: Role Sequence/);
    });

    test('Invariant 3: Content hash mismatch triggers error', () => {
        const mismatched = {
            ...validActual,
            chat: [
                { role: 'system', content: 'Prompt A Modified' },
                { role: 'user', content: 'Prompt B' },
            ],
        };
        expect(() => PromptDiffAsserter.assertContentTextAndHash(mismatched, validActual))
            .toThrow(/Assertion 3 Failed: Content Text & Hash Invariant/);
    });

    test('Invariant 4: Slot topology mismatch triggers error', () => {
        const mismatched = {
            ...validActual,
            metadata: { ...validActual.metadata, injectedPromptsCount: 2 },
        };
        expect(() => PromptDiffAsserter.assertSlotTopology(mismatched, validActual))
            .toThrow(/Assertion 4 Failed: Slot Topology/);
    });

    test('Invariant 5: Whitelist violation in squashed system messages triggers error', () => {
        const mismatched = {
            ...validActual,
            chat: [
                { role: 'system', content: 'Merged\n--- Chat Begins ---' },
            ],
        };
        expect(() => PromptDiffAsserter.assertSquashedSystemMessages(mismatched, validActual))
            .toThrow(/Assertion 5 Failed: Squashed System Messages Whitelist Violation/);
    });

    test('Invariant 6: Tool calls mismatch triggers error', () => {
        const expected = {
            chat: [{ role: 'assistant', tool_calls: [{ id: '1' }] }],
        };
        const actual = {
            chat: [{ role: 'assistant', tool_calls: [{ id: '2' }] }],
        };
        expect(() => PromptDiffAsserter.assertToolCallPairsAndReasoning(actual, expected))
            .toThrow(/Assertion 6 Failed: Tool Call Invariant/);
    });

    test('Invariant 7: Multimodal layout mismatch triggers error', () => {
        const expected = {
            chat: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://a' } }] }],
        };
        const actual = {
            chat: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://b' } }] }],
        };
        expect(() => PromptDiffAsserter.assertMultimodalLayout(actual, expected))
            .toThrow(/Assertion 7 Failed: Multimodal Layout/);
    });

    test('Invariant 8: Token budget accounting mismatch triggers error', () => {
        const mismatched = {
            ...validActual,
            metadata: { ...validActual.metadata, tokensUsed: 999 },
        };
        expect(() => PromptDiffAsserter.assertTokenBudgetAccounting(mismatched, validActual))
            .toThrow(/Assertion 8 Failed: Token Budget Accounting/);
    });
});
