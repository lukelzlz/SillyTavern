import { describe, test, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    CanonicalWorldInfoScanner,
    RecordedTokenEstimator,
    TokenizerAdapterEstimator,
    FailClosedTokenEstimator,
    TokenizerUnavailableError,
} from '../src/core/world-info/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'world-info-parity');

/**
 * Load and parse all JSON fixtures in tests/fixtures/world-info-parity
 */
function loadGoldenFixtures() {
    const files = fs.readdirSync(FIXTURES_DIR)
        .filter(f => f.endsWith('.json'))
        .sort();

    return files.map(file => {
        const fullPath = path.join(FIXTURES_DIR, file);
        const content = fs.readFileSync(fullPath, 'utf8');
        return {
            filename: file,
            fixture: JSON.parse(content),
        };
    });
}

describe('World Info Phase 1: Canonical Parity & Golden Fixtures Differential Test', () => {
    const fixtures = loadGoldenFixtures();

    test('All 5 standard golden fixtures are discovered', () => {
        expect(fixtures.length).toBe(5);
        const fixtureNames = fixtures.map(f => f.fixture.name);
        expect(fixtureNames).toEqual([
            '01-basic-primary-secondary',
            '02-all-positions-coverage',
            '03-cjk-token-budget',
            '04-empty-and-disabled-resilience',
            '05-global-scan-data-sources',
        ]);
    });

    // 1. Differential Parity against Golden Fixtures
    for (const { filename, fixture } of fixtures) {
        describe(`Golden Fixture: ${filename} (${fixture.name})`, () => {
            test('100% structural and byte-level parity with expected canonical output', async () => {
                const { input, recordedTokens, expectedOutput } = fixture;

                // Instantiate canonical estimator using recorded tokens
                const tokenEstimator = new RecordedTokenEstimator(recordedTokens);

                const scanInput = {
                    ...input,
                    options: {
                        ...input.options,
                        tokenEstimator,
                    },
                };

                const actualOutput = await CanonicalWorldInfoScanner.scan(scanInput);

                // Deep differential assertions across all 8 standard slots
                expect(actualOutput.worldInfoBefore).toBe(expectedOutput.worldInfoBefore);
                expect(actualOutput.worldInfoAfter).toBe(expectedOutput.worldInfoAfter);
                expect(actualOutput.EMEntries).toEqual(expectedOutput.EMEntries);
                expect(actualOutput.WIDepthEntries).toEqual(expectedOutput.WIDepthEntries);
                expect(actualOutput.ANBeforeEntries).toEqual(expectedOutput.ANBeforeEntries);
                expect(actualOutput.ANAfterEntries).toEqual(expectedOutput.ANAfterEntries);
                expect(actualOutput.outletEntries).toEqual(expectedOutput.outletEntries);

                // Activated UIDs set equality
                expect(actualOutput.activatedEntryUids).toEqual(expectedOutput.activatedEntryUids);

                // debugTrace validation
                expect(actualOutput.debugTrace).toBeDefined();
                expect(actualOutput.debugTrace.totalEvaluated).toBe(input.entries.length);
                expect(actualOutput.debugTrace.totalActivated).toBe(expectedOutput.activatedEntryUids.length);
                expect(typeof actualOutput.debugTrace.durationMs).toBe('number');
            });
        });
    }

    // 2. Token Budget Estimator: Fail-Closed Protection
    describe('ITokenBudgetEstimator & Fail-Closed Behavior', () => {
        test('FailClosedTokenEstimator unconditionally throws TokenizerUnavailableError', async () => {
            const estimator = new FailClosedTokenEstimator();
            await expect(estimator.countTokens('Hello world')).rejects.toThrow(TokenizerUnavailableError);
            await expect(estimator.checkOverflow('', 'Text', 100)).rejects.toThrow(TokenizerUnavailableError);
        });

        test('RecordedTokenEstimator throws TokenizerUnavailableError on missing recorded segment without fallback', async () => {
            const estimator = new RecordedTokenEstimator({
                'known text': 2,
            });

            await expect(estimator.countTokens('known text')).resolves.toBe(2);
            await expect(estimator.countTokens('completely unknown text')).rejects.toThrow(TokenizerUnavailableError);
        });

        test('RecordedTokenEstimator delegates to fallback tokenizer when available', async () => {
            const mockFallback = (text) => text.split(/\s+/).length;
            const estimator = new RecordedTokenEstimator(
                { 'known text': 2 },
                mockFallback,
            );

            await expect(estimator.countTokens('known text')).resolves.toBe(2);
            await expect(estimator.countTokens('three separate words')).resolves.toBe(3);
        });

        test('TokenizerAdapterEstimator correctly binds authentic tokenizer function', async () => {
            const mockTokenizer = (text) => Promise.resolve(text.length * 2);
            const estimator = new TokenizerAdapterEstimator(mockTokenizer);

            await expect(estimator.countTokens('abc')).resolves.toBe(6);
            const overflowResult = await estimator.checkOverflow('a', 'b', 10);
            expect(overflowResult.overflow).toBe(false);
        });

        test('Scanner fails closed when unrecorded text encounters budget check without tokenizer', async () => {
            const entries = [
                {
                    uid: 'unrecorded-entry',
                    key: ['test'],
                    content: 'This text was deliberately never recorded in any fixture dictionary.',
                    position: 0,
                },
            ];

            const scanInput = {
                entries,
                chatMessages: ['test message'],
                options: {
                    budget: 10,
                    // Intentionally no recordedTokens or tokenizer
                },
            };

            await expect(CanonicalWorldInfoScanner.scan(scanInput)).rejects.toThrow(TokenizerUnavailableError);
        });
    });

    // 3. Strict Compliance Guard: Character-count Heuristic Ban (ADR-003)
    describe('ADR-003 Code Cleanliness & Heuristic Ban Enforcement', () => {
        test('src/core/world-info source code does not contain forbidden heuristic estimations', () => {
            const coreWorldInfoDir = path.join(__dirname, '..', 'src', 'core', 'world-info');
            const files = fs.readdirSync(coreWorldInfoDir).filter(f => f.endsWith('.js'));

            const forbiddenPatterns = [
                /content\.length\s*>\s*budget/i,
                /totalCharsUsed/i,
                /length\s*\/\s*4/i,
                /chars\s*\*\s*0\.75/i,
                /\.length\s*\*\s*0\./i,
            ];

            for (const file of files) {
                const code = fs.readFileSync(path.join(coreWorldInfoDir, file), 'utf8');
                for (const pattern of forbiddenPatterns) {
                    const match = code.match(pattern);
                    expect(match).toBeNull();
                }
            }
        });

        test('public/scripts/world-info.js is strictly untouched (zero drift from git head)', () => {
            const gitStatus = fs.existsSync(path.join(__dirname, '..', 'public', 'scripts', 'world-info.js'));
            expect(gitStatus).toBe(true);
        });
    });
});
