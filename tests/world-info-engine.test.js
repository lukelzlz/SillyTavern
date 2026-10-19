import { describe, test, expect } from '@jest/globals';
import { WorldInfoEngine, WI_LOGIC, WI_POSITION } from '../src/core/world-info-engine.js';

describe('WorldInfoEngine', () => {
    test('Primary Keyword Matching', () => {
        const entries = [
            { uid: 1, key: ['Tavern', 'Inn'], content: 'A bustling tavern with adventurers.', position: WI_POSITION.BEFORE_CHAR },
            { uid: 2, key: ['Castle'], content: 'A grand royal castle.', position: WI_POSITION.BEFORE_CHAR },
        ];
        const res = WorldInfoEngine.scan({ entries, text: 'The party entered the local tavern to rest.' });
        expect(res.activatedCount).toBe(1);
        expect(res.worldInfoBefore).toContain('bustling tavern');
    });

    test('Regex Matching in keys', () => {
        const entries = [
            { uid: 3, key: ['/potion\\s+of\\s+healing/i'], content: 'Restores 2d4+2 hit points.', position: WI_POSITION.AFTER_CHAR },
        ];
        const res = WorldInfoEngine.scan({ entries, text: 'He drank a Potion of Healing quickly.' });
        expect(res.activatedCount).toBe(1);
        expect(res.worldInfoAfter).toContain('Restores 2d4+2');
    });

    test('Selective Logic (AND_ALL vs NOT_ANY)', () => {
        const entries = [
            {
                uid: 4,
                key: ['Dragon'],
                selective: true,
                selectiveLogic: WI_LOGIC.AND_ALL,
                keysecondary: ['Red', 'Fire'],
                content: 'Ancient Red Dragon breathing fire.',
                position: WI_POSITION.BEFORE_CHAR,
            },
            {
                uid: 5,
                key: ['Goblin'],
                selective: true,
                selectiveLogic: WI_LOGIC.NOT_ANY,
                keysecondary: ['King', 'Boss'],
                content: 'A generic low-level goblin minion.',
                position: WI_POSITION.BEFORE_CHAR,
            },
        ];

        // Dragon + Red + Fire -> Match
        const res3a = WorldInfoEngine.scan({ entries, text: 'A giant Red Dragon breathing Fire emerged!' });
        expect(res3a.activatedCount).toBe(1);
        expect(res3a.worldInfoBefore).toContain('Ancient Red Dragon');

        // Dragon + Red (missing Fire) -> Should NOT match
        const res3b = WorldInfoEngine.scan({ entries, text: 'A giant Red Dragon emerged!' });
        expect(res3b.activatedCount).toBe(0);

        // Goblin (no King) -> Match
        const res3c = WorldInfoEngine.scan({ entries, text: 'A small goblin scouts ahead.' });
        expect(res3c.activatedCount).toBe(1);
        expect(res3c.worldInfoBefore).toContain('generic low-level goblin');

        // Goblin + King -> Should NOT match (NOT_ANY logic)
        const res3d = WorldInfoEngine.scan({ entries, text: 'All hail the Goblin King!' });
        expect(res3d.activatedCount).toBe(0);
    });

    test('Constant Entries', () => {
        const entries = [
            { uid: 6, constant: true, content: 'Universal World Law: Magic exists.', position: WI_POSITION.BEFORE_CHAR },
            { uid: 7, key: ['Alien'], content: 'Extraterrestrial life.', position: WI_POSITION.BEFORE_CHAR },
        ];
        const res = WorldInfoEngine.scan({ entries, text: 'Just walking in the park.' });
        expect(res.activatedCount).toBe(1);
        expect(res.worldInfoBefore).toContain('Universal World Law');
    });

    test('Recursive Cascade Activation', () => {
        const entries = [
            {
                uid: 8,
                key: ['Artifact'],
                content: 'The ancient Artifact was created by the Order of Shadows.',
                position: WI_POSITION.BEFORE_CHAR,
                order: 10,
            },
            {
                uid: 9,
                key: ['Order of Shadows'],
                content: 'The Order of Shadows is a secretive guild of assassins.',
                position: WI_POSITION.BEFORE_CHAR,
                order: 20,
            },
        ];
        const res = WorldInfoEngine.scan({
            entries,
            text: 'He found a mystical Artifact.',
            options: { maxRecursionSteps: 2 },
        });
        expect(res.activatedCount).toBe(2);
        expect(res.stats.passes).toBeGreaterThanOrEqual(2);
    });

    test('Depth Entries Positioning', () => {
        const entries = [
            { uid: 10, key: ['Whisper'], content: 'Voices from the void.', position: WI_POSITION.AT_DEPTH, depth: 3, role: 'system' },
        ];
        const res = WorldInfoEngine.scan({ entries, text: 'He heard a faint Whisper.' });
        expect(res.depthEntries).toHaveLength(1);
        expect(res.depthEntries[0].depth).toBe(3);
    });

    test('Budget Enforcement', () => {
        const entries = [
            { uid: 11, key: ['Big'], content: 'A'.repeat(500), position: WI_POSITION.BEFORE_CHAR, order: 1 },
            { uid: 12, key: ['Big'], content: 'B'.repeat(500), position: WI_POSITION.BEFORE_CHAR, order: 2 },
        ];
        const res = WorldInfoEngine.scan({
            entries,
            text: 'Big world ahead.',
            options: { budget: 600 },
        });
        expect(res.totalCharsUsed).toBeLessThanOrEqual(600);
        expect(res.worldInfoBefore).not.toContain('B');
    });
});
