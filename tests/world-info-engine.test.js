import { WorldInfoEngine, WI_LOGIC, WI_POSITION } from '../src/core/world-info-engine.js';

async function runWorldInfoTests() {
    console.log('--- Starting World Info Server Engine Tests ---');

    // Test 1: Primary Keyword Matching
    console.log('[Test 1] Primary Keyword Matching...');
    const entries1 = [
        { uid: 1, key: ['Tavern', 'Inn'], content: 'A bustling tavern with adventurers.', position: WI_POSITION.BEFORE_CHAR },
        { uid: 2, key: ['Castle'], content: 'A grand royal castle.', position: WI_POSITION.BEFORE_CHAR },
    ];
    const res1 = WorldInfoEngine.scan({ entries: entries1, text: 'The party entered the local tavern to rest.' });
    if (res1.activatedCount !== 1 || !res1.worldInfoBefore.includes('bustling tavern')) {
        throw new Error(`Test 1 Failed: ${JSON.stringify(res1)}`);
    }
    console.log('✓ Test 1 Passed: Primary keyword activated correctly');

    // Test 2: Regex Matching
    console.log('[Test 2] Regex Matching in keys...');
    const entries2 = [
        { uid: 3, key: ['/potion\\s+of\\s+healing/i'], content: 'Restores 2d4+2 hit points.', position: WI_POSITION.AFTER_CHAR },
    ];
    const res2 = WorldInfoEngine.scan({ entries: entries2, text: 'He drank a Potion of Healing quickly.' });
    if (res2.activatedCount !== 1 || !res2.worldInfoAfter.includes('Restores 2d4+2')) {
        throw new Error(`Test 2 Failed: ${JSON.stringify(res2)}`);
    }
    console.log('✓ Test 2 Passed: Regex pattern matched');

    // Test 3: Selective Logic (AND_ALL vs NOT_ANY)
    console.log('[Test 3] Selective Logic...');
    const entries3 = [
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

    // Case 3a: Dragon + Red + Fire -> Match
    const res3a = WorldInfoEngine.scan({ entries: entries3, text: 'A giant Red Dragon breathing Fire emerged!' });
    if (res3a.activatedCount !== 1 || !res3a.worldInfoBefore.includes('Ancient Red Dragon')) {
        throw new Error(`Test 3a Failed: ${JSON.stringify(res3a)}`);
    }

    // Case 3b: Dragon + Red (missing Fire) -> Should NOT match
    const res3b = WorldInfoEngine.scan({ entries: entries3, text: 'A giant Red Dragon emerged!' });
    if (res3b.activatedCount !== 0) {
        throw new Error(`Test 3b Failed: Expected 0 matches, got ${res3b.activatedCount}`);
    }

    // Case 3c: Goblin (no King) -> Match
    const res3c = WorldInfoEngine.scan({ entries: entries3, text: 'A small goblin scouts ahead.' });
    if (res3c.activatedCount !== 1 || !res3c.worldInfoBefore.includes('generic low-level goblin')) {
        throw new Error(`Test 3c Failed: ${JSON.stringify(res3c)}`);
    }

    // Case 3d: Goblin + King -> Should NOT match (NOT_ANY logic)
    const res3d = WorldInfoEngine.scan({ entries: entries3, text: 'All hail the Goblin King!' });
    if (res3d.activatedCount !== 0) {
        throw new Error(`Test 3d Failed: Expected 0 matches for Goblin King, got ${res3d.activatedCount}`);
    }
    console.log('✓ Test 3 Passed: Selective logic (AND_ALL & NOT_ANY) verified');

    // Test 4: Constant Entries
    console.log('[Test 4] Constant Entries...');
    const entries4 = [
        { uid: 6, constant: true, content: 'Universal World Law: Magic exists.', position: WI_POSITION.BEFORE_CHAR },
        { uid: 7, key: ['Alien'], content: 'Extraterrestrial life.', position: WI_POSITION.BEFORE_CHAR },
    ];
    const res4 = WorldInfoEngine.scan({ entries: entries4, text: 'Just walking in the park.' });
    if (res4.activatedCount !== 1 || !res4.worldInfoBefore.includes('Universal World Law')) {
        throw new Error('Test 4 Failed: Constant entry didn\'t activate');
    }
    console.log('✓ Test 4 Passed: Constant entry activated unconditionally');

    // Test 5: Recursive Cascade Activation
    console.log('[Test 5] Recursive Cascade Matching...');
    const entries5 = [
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
    // Input text only mentions "Artifact", but its content mentions "Order of Shadows" which triggers entry 9!
    const res5 = WorldInfoEngine.scan({
        entries: entries5,
        text: 'He found a mystical Artifact.',
        options: { maxRecursionSteps: 2 },
    });
    if (res5.activatedCount !== 2 || res5.stats.passes < 2) {
        throw new Error(`Test 5 Failed: Recursive activation failed: ${JSON.stringify(res5)}`);
    }
    console.log(`✓ Test 5 Passed: Recursive cascade triggered (passes: ${res5.stats.passes}, activated: ${res5.activatedCount})`);

    // Test 6: Depth Entries Positioning
    console.log('[Test 6] Depth Entries Positioning...');
    const entries6 = [
        { uid: 10, key: ['Whisper'], content: 'Voices from the void.', position: WI_POSITION.AT_DEPTH, depth: 3, role: 'system' },
    ];
    const res6 = WorldInfoEngine.scan({ entries: entries6, text: 'He heard a faint Whisper.' });
    if (res6.depthEntries.length !== 1 || res6.depthEntries[0].depth !== 3) {
        throw new Error('Test 6 Failed: Depth entry missing or wrong depth');
    }
    console.log('✓ Test 6 Passed: Depth positioning verified');

    // Test 7: Budget Enforcement
    console.log('[Test 7] Budget Enforcement...');
    const entries7 = [
        { uid: 11, key: ['Big'], content: 'A'.repeat(500), position: WI_POSITION.BEFORE_CHAR, order: 1 },
        { uid: 12, key: ['Big'], content: 'B'.repeat(500), position: WI_POSITION.BEFORE_CHAR, order: 2 },
    ];
    const res7 = WorldInfoEngine.scan({
        entries: entries7,
        text: 'Big world ahead.',
        options: { budget: 600 },
    });
    // With budget 600, only entry 11 (500 chars) fits; entry 12 exceeds budget
    if (res7.totalCharsUsed > 600 || res7.worldInfoBefore.includes('B')) {
        throw new Error('Test 7 Failed: Budget exceeded');
    }
    console.log('✓ Test 7 Passed: Budget constraint enforced correctly');

    console.log('\n🎉 ALL 7 WORLD INFO TESTS PASSED! 🎉');
}

runWorldInfoTests();
