// Copyright (C) 2024–2026 Aiko Hanasaki
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { applyRegenerationReplacement, getEntryByUid } from './memoryRegeneration.js';

// addlore.js imports directly from SillyTavern host paths (../../../extensions.js, world-info.js,
// etc.) that don't exist in this standalone repo checkout, so it can't be `import`ed normally under
// node:test. Following the same pattern as stmbJobsProgress.test.js / stmbProgress.test.js: load the
// real source text, strip the import/export syntax, and run it in a vm context with host APIs
// stubbed. applyRegenerationReplacement/getEntryByUid are pure (memoryRegeneration.js has no host
// imports) so we import and inject the real implementations rather than mocking them.

const ADDLORE_EXPORTS = [
    'markEntryAsArc',
    'getArcEntry',
    'getCharacterEntry',
    'setCharacterEntryBinding',
    'filterCharactersForReconciliation',
    'detectCharacterNamesInSceneText',
    'upsertArcEntry',
    'upsertCharacterEntry',
    'createNewCharacterEntry',
    'applySceneReconciliationChanges',
];

function i18nStub(key, fallback, params) {
    return String(fallback ?? '').replace(/{{\s*(\w+)\s*}}/g, (_, name) =>
        (params?.[name] === undefined || params?.[name] === null) ? '' : String(params[name]));
}

function loadAddlore(overrides = {}) {
    const source = readFileSync(new URL('./addlore.js', import.meta.url), 'utf8')
        .replace(/^import[\s\S]*?;\r?\n/gm, '')
        .replace(/^export /gm, '');

    const state = {
        savedLorebooks: [],
        reloadedEditors: [],
        createdEntries: [],
        nextUid: 1000,
    };

    const context = {
        console,
        structuredClone,
        i18n: i18nStub,
        getEntryByUid,
        applyRegenerationReplacement,
        extension_settings: { STMemoryBooks: { moduleSettings: { showNotifications: false } } },
        newWorldInfoEntryTemplate: {},
        toastr: {
            success() {}, error() {}, info() {}, warning() {},
        },
        saveWorldInfo: async (name, data) => {
            state.savedLorebooks.push({ name, data: structuredClone(data) });
        },
        reloadEditor: async (name) => {
            state.reloadedEditors.push(name);
        },
        createWorldInfoEntry: (name, lorebookData) => {
            const uid = state.nextUid++;
            const entry = { uid, comment: '', content: '', key: [] };
            lorebookData.entries[uid] = entry;
            state.createdEntries.push(entry);
            return entry;
        },
        ...overrides,
    };

    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'addlore.js (sandbox)' });

    const api = {};
    for (const name of ADDLORE_EXPORTS) api[name] = context[name];
    return { api, state, context };
}

function lorebook(entries) {
    return { entries: Object.fromEntries(entries.map(entry => [entry.uid, entry])) };
}

function compiledSceneWithText(messageTexts, presentCharacterNames = []) {
    return {
        messages: messageTexts.map(mes => ({ mes })),
        metadata: { presentCharacterNames },
    };
}

// --- getArcEntry() ---

test('getArcEntry finds the entry via the metadata fast-path', () => {
    const { api } = loadAddlore();
    const arcEntry = { uid: 5, comment: 'Arc Tracker', STMB_isArcEntry: true };
    const lorebookData = lorebook([{ uid: 1, comment: 'Other' }, arcEntry]);
    const result = api.getArcEntry(lorebookData, { STMB_arcEntryUid: '5' });
    assert.equal(result.entry, arcEntry);
    assert.equal(result.source, 'metadata');
});

test('getArcEntry falls back to a flag-scan when no metadata uid resolves', () => {
    const { api } = loadAddlore();
    const arcEntry = { uid: 2, comment: 'Legacy Arc', STMB_isArcEntry: true };
    const lorebookData = lorebook([{ uid: 1, comment: 'Other' }, arcEntry]);
    const result = api.getArcEntry(lorebookData, {});
    assert.equal(result.entry, arcEntry);
    assert.equal(result.source, 'flag');
});

test('getArcEntry falls back to a flag-scan when a stale metadata uid does not resolve', () => {
    const { api } = loadAddlore();
    const arcEntry = { uid: 2, comment: 'Legacy Arc', STMB_isArcEntry: true };
    const lorebookData = lorebook([{ uid: 1, comment: 'Other' }, arcEntry]);
    const result = api.getArcEntry(lorebookData, { STMB_arcEntryUid: '999' });
    assert.equal(result.entry, arcEntry);
    assert.equal(result.source, 'flag');
});

test('getArcEntry returns not_found when there is no metadata match or flagged entry', () => {
    const { api } = loadAddlore();
    const lorebookData = lorebook([{ uid: 1, comment: 'Other' }]);
    const result = api.getArcEntry(lorebookData, {});
    assert.equal(result.entry, null);
    assert.equal(result.source, 'not_found');
});

// --- getCharacterEntry() ---

test('getCharacterEntry matches on the canonical STMB_characterName field first', () => {
    const { api } = loadAddlore();
    const canonical = { uid: 1, comment: 'Alice', STMB_characterName: 'Alice' };
    const lorebookData = lorebook([canonical]);
    const result = api.getCharacterEntry(lorebookData, 'Alice');
    assert.equal(result.entry, canonical);
    assert.equal(result.source, 'canonical');
});

test('getCharacterEntry falls back to a characterFilter.names match', () => {
    const { api } = loadAddlore();
    const filtered = { uid: 1, comment: 'Alice Notes', characterFilter: { names: ['Alice'] } };
    const lorebookData = lorebook([filtered]);
    const result = api.getCharacterEntry(lorebookData, 'alice');
    assert.equal(result.entry, filtered);
    assert.equal(result.source, 'filter');
});

test('getCharacterEntry falls back to a weak comment-substring heuristic match', () => {
    const { api } = loadAddlore();
    const heuristic = { uid: 1, comment: 'About Alice the Wanderer' };
    const lorebookData = lorebook([heuristic]);
    const result = api.getCharacterEntry(lorebookData, 'Alice');
    assert.equal(result.entry, heuristic);
    assert.equal(result.source, 'heuristic');
});

test('getCharacterEntry returns not_found when nothing matches', () => {
    const { api } = loadAddlore();
    const lorebookData = lorebook([{ uid: 1, comment: 'Bob' }]);
    const result = api.getCharacterEntry(lorebookData, 'Alice');
    assert.equal(result.entry, null);
    assert.equal(result.source, 'not_found');
});

// --- markEntryAsArc() / setCharacterEntryBinding() ---

test('markEntryAsArc sets the canonical Arc fields and unflags any previous Arc entry', () => {
    const { api } = loadAddlore();
    const oldArc = { uid: 1, comment: 'Old Arc', STMB_isArcEntry: true, STMB_characterEntryType: 'arc' };
    const newArc = { uid: 2, comment: 'New Arc' };
    const lorebookData = lorebook([oldArc, newArc]);

    const result = api.markEntryAsArc(lorebookData, 2);

    assert.equal(result.success, true);
    assert.equal(newArc.STMB_isArcEntry, true);
    assert.equal(newArc.STMB_characterEntryType, 'arc');
    assert.equal(oldArc.STMB_isArcEntry, false);
    assert.equal(lorebookData.STMB_arcEntryUid, '2');
    assert.equal(lorebookData.STMB_arcTrackingEnabled, true);
});

test('markEntryAsArc reports failure for an unresolved uid', () => {
    const { api } = loadAddlore();
    const lorebookData = lorebook([{ uid: 1, comment: 'Only' }]);
    const result = api.markEntryAsArc(lorebookData, 999);
    assert.equal(result.success, false);
});

test('setCharacterEntryBinding stamps the character name and entry type', () => {
    const { api } = loadAddlore();
    const entry = { uid: 1, comment: 'Alice' };
    const returned = api.setCharacterEntryBinding(entry, 'Alice');
    assert.equal(returned, entry);
    assert.equal(entry.STMB_characterName, 'Alice');
    assert.equal(entry.STMB_characterEntryType, 'character');
});

// --- filterCharactersForReconciliation() ---

test('filterCharactersForReconciliation buckets existing, new, and excluded characters', () => {
    const { api } = loadAddlore();
    const aliceEntry = { uid: 1, comment: 'Alice', STMB_characterName: 'Alice' };
    const lorebookData = lorebook([aliceEntry]);

    const result = api.filterCharactersForReconciliation(
        ['Alice', 'Bob', 'Narrator', 'Alice'],
        lorebookData,
        { excludePatterns: ['Narrator'] },
    );

    assert.deepEqual(structuredClone(result.existing), [{ name: 'Alice', entry: aliceEntry }]);
    assert.deepEqual(structuredClone(result.new), [{ name: 'Bob' }]);
    assert.deepEqual(structuredClone(result.excluded), [{ name: 'Narrator', reason: 'excludePattern' }]);
    assert.equal(result.metadata.totalInput, 4);
    assert.equal(result.metadata.totalConsidered, 3);
    assert.equal(result.metadata.existingCount, 1);
    assert.equal(result.metadata.newCount, 1);
    assert.equal(result.metadata.excludedCount, 1);
});

// --- detectCharacterNamesInSceneText() ---

test('detectCharacterNamesInSceneText finds an existing character entry canonical name mentioned in message text', () => {
    const { api } = loadAddlore();
    const aliceEntry = { uid: 1, comment: 'Alice', STMB_characterName: 'Alice' };
    const lorebookData = lorebook([aliceEntry]);
    const scene = compiledSceneWithText(['The narrator describes Alice walking into the tavern.']);

    const result = api.detectCharacterNamesInSceneText(scene, lorebookData);

    assert.deepEqual(structuredClone(result), ['Alice']);
});

test('detectCharacterNamesInSceneText matches an existing entry via the characterFilter.names[0] fallback', () => {
    const { api } = loadAddlore();
    const bobEntry = { uid: 1, comment: 'Bob Notes', characterFilter: { names: ['Bob'] } };
    const lorebookData = lorebook([bobEntry]);
    const scene = compiledSceneWithText(['Bob walked to the market and back.']);

    const result = api.detectCharacterNamesInSceneText(scene, lorebookData);

    assert.deepEqual(structuredClone(result), ['Bob']);
});

test('detectCharacterNamesInSceneText returns a repeated capitalized name as a heuristic candidate', () => {
    const { api } = loadAddlore();
    const lorebookData = lorebook([]);
    const scene = compiledSceneWithText([
        'Zephyr walked into the room.',
        'Zephyr smiled and said hello.',
    ]);

    const result = api.detectCharacterNamesInSceneText(scene, lorebookData);

    assert.deepEqual(structuredClone(result), ['Zephyr']);
});

test('detectCharacterNamesInSceneText does not return a capitalized word seen only once', () => {
    const { api } = loadAddlore();
    const lorebookData = lorebook([]);
    const scene = compiledSceneWithText(['Zephyr walked into the room once and was never mentioned again.']);

    const result = api.detectCharacterNamesInSceneText(scene, lorebookData);

    assert.deepEqual(structuredClone(result), []);
});

test('detectCharacterNamesInSceneText excludes common stopwords regardless of frequency', () => {
    const { api } = loadAddlore();
    const lorebookData = lorebook([]);
    const scene = compiledSceneWithText(['The The The. Okay Okay Okay.']);

    const result = api.detectCharacterNamesInSceneText(scene, lorebookData);

    assert.deepEqual(structuredClone(result), []);
});

test('detectCharacterNamesInSceneText does not duplicate names already in compiledScene.metadata.presentCharacterNames', () => {
    const { api } = loadAddlore();
    const lorebookData = lorebook([]);
    const scene = compiledSceneWithText(
        ['Zephyr appeared. Zephyr spoke again.'],
        ['Zephyr'],
    );

    const result = api.detectCharacterNamesInSceneText(scene, lorebookData);

    assert.deepEqual(structuredClone(result), []);
});

test('detectCharacterNamesInSceneText honors options.excludePatterns for both string and RegExp forms', () => {
    const { api, context } = loadAddlore();
    const lorebookData = lorebook([]);
    const scene = compiledSceneWithText([
        'Narrator spoke. Narrator continued. Zephyr answered. Zephyr answered again.',
    ]);
    // Built by evaluating a regex literal inside the sandbox realm: a host-realm RegExp would fail
    // the implementation's `pattern instanceof RegExp` check across the vm context boundary.
    const zephyrPattern = vm.runInContext('/^Zeph/', context);

    const result = api.detectCharacterNamesInSceneText(scene, lorebookData, {
        excludePatterns: ['Narrator', zephyrPattern],
    });

    assert.deepEqual(structuredClone(result), []);
});

test('detectCharacterNamesInSceneText caps heuristic candidates via options.maxNewCandidates, keeping the highest-frequency ones', () => {
    const { api } = loadAddlore();
    const lorebookData = lorebook([]);
    const scene = compiledSceneWithText([
        'Zephyr Zephyr Zephyr Zephyr.',
        'Talon Talon Talon.',
        'Mira Mira.',
    ]);

    const result = api.detectCharacterNamesInSceneText(scene, lorebookData, { maxNewCandidates: 2 });

    assert.deepEqual(structuredClone(result), ['Zephyr', 'Talon']);
});

test('detectCharacterNamesInSceneText dedups case-insensitively between existing matches and heuristic candidates', () => {
    const { api } = loadAddlore();
    const aliceEntry = { uid: 1, comment: 'Alice', STMB_characterName: 'Alice' };
    const lorebookData = lorebook([aliceEntry]);
    const scene = compiledSceneWithText(['Alice greeted Alice again since Alice was repeated.']);

    const result = api.detectCharacterNamesInSceneText(scene, lorebookData);

    assert.deepEqual(structuredClone(result), ['Alice']);
});

// --- upsertArcEntry() / upsertCharacterEntry() / createNewCharacterEntry() ---

test('upsertArcEntry updates the resolved Arc entry in place and saves once', async () => {
    const { api, state } = loadAddlore();
    const arcEntry = { uid: 1, comment: 'Old Arc Title', content: 'Old content', key: ['old'], STMB_isArcEntry: true };
    const lorebookData = lorebook([arcEntry]);

    const result = await api.upsertArcEntry('MyBook', lorebookData, {
        content: 'New arc content', title: 'New Arc Title', keywords: ['new'],
    });

    assert.equal(result.success, true);
    assert.equal(result.uid, 1);
    assert.equal(arcEntry.content, 'New arc content');
    assert.equal(arcEntry.comment, 'New Arc Title');
    assert.deepEqual(arcEntry.key, ['new']);
    assert.equal(arcEntry.STMB_isArcEntry, true);
    assert.equal(lorebookData.STMB_arcEntryUid, '1');
    assert.equal(state.savedLorebooks.length, 1);
    assert.equal(state.savedLorebooks[0].name, 'MyBook');
});

test('upsertArcEntry reports failure without saving when no Arc entry can be resolved', async () => {
    const { api, state } = loadAddlore();
    const lorebookData = lorebook([{ uid: 1, comment: 'Not an arc entry' }]);

    const result = await api.upsertArcEntry('MyBook', lorebookData, { content: 'x' });

    assert.equal(result.success, false);
    assert.ok(result.error);
    assert.equal(state.savedLorebooks.length, 0);
});

test('upsertCharacterEntry updates the resolved character entry and binds the character name', async () => {
    const { api, state } = loadAddlore();
    const charEntry = { uid: 3, comment: 'Alice Old', content: 'Old bio', key: [] };
    const lorebookData = lorebook([charEntry]);

    const result = await api.upsertCharacterEntry('MyBook', lorebookData, 'Alice Old', {
        content: 'New bio', title: 'Alice New', keywords: ['alice'],
    });

    assert.equal(result.success, true);
    assert.equal(charEntry.content, 'New bio');
    assert.equal(charEntry.comment, 'Alice New');
    assert.equal(charEntry.STMB_characterName, 'Alice Old');
    assert.equal(charEntry.STMB_characterEntryType, 'character');
    assert.equal(state.savedLorebooks.length, 1);
});

test('upsertCharacterEntry reports failure without saving when the character has no existing entry', async () => {
    const { api, state } = loadAddlore();
    const lorebookData = lorebook([]);

    const result = await api.upsertCharacterEntry('MyBook', lorebookData, 'Ghost', { content: 'x' });

    assert.equal(result.success, false);
    assert.equal(state.savedLorebooks.length, 0);
});

test('createNewCharacterEntry creates, binds, and saves a brand-new entry without touching real I/O', async () => {
    const { api, state } = loadAddlore();
    const lorebookData = { entries: {} };

    const result = await api.createNewCharacterEntry('MyBook', lorebookData, 'Bob', {
        title: 'Bob', content: 'Bob is new here', keywords: ['bob', 'newcomer'],
    });

    assert.equal(result.success, true);
    assert.equal(state.createdEntries.length, 1);
    const created = state.createdEntries[0];
    assert.equal(created.uid, result.uid);
    assert.equal(created.comment, 'Bob');
    assert.equal(created.content, 'Bob is new here');
    assert.deepEqual(structuredClone(created.key), ['bob', 'newcomer']);
    assert.equal(created.STMB_characterName, 'Bob');
    assert.equal(created.STMB_characterEntryType, 'character');
    assert.equal(created.stmemorybooks, true);
    assert.equal(state.savedLorebooks.length, 1);
});

// --- applySceneReconciliationChanges() ---

test('applySceneReconciliationChanges aggregates created/updated counts across arc, character, and new-character items', async () => {
    const { api, state } = loadAddlore();
    const arcEntry = { uid: 1, comment: 'Arc Entry', content: 'Old arc' };
    const charEntry = { uid: 2, comment: 'Alice', content: 'Old alice bio' };
    const lorebookData = lorebook([arcEntry, charEntry]);

    const reconciliationResult = {
        arcOperation: { status: 'processed', entry: arcEntry, proposedContent: 'New arc content' },
        characterOperations: [
            { status: 'processed', entry: charEntry, characterName: 'Alice', proposedContent: 'New alice bio' },
            { status: 'error', entry: charEntry, characterName: 'Broken', error: 'llm failed' },
        ],
        newCharacterProposals: [
            {
                userApproved: true, characterName: 'Bob', proposedContent: 'Bob bio',
                proposedTitle: 'Bob', proposedKeywords: ['bob'],
            },
            { userApproved: false, characterName: 'Rejected', proposedContent: 'nope' },
        ],
    };

    const result = await api.applySceneReconciliationChanges('MyBook', lorebookData, reconciliationResult);

    assert.equal(result.createdCount, 1);
    assert.equal(result.updatedCount, 2);
    assert.deepEqual(structuredClone(result.errors), []);
    assert.equal(arcEntry.content, 'New arc content');
    assert.equal(charEntry.content, 'New alice bio');
    assert.equal(state.createdEntries.length, 1);
    assert.equal(state.createdEntries[0].comment, 'Bob');
});

test('applySceneReconciliationChanges collects the batch error without throwing on partial failure', async () => {
    const { api, state } = loadAddlore({
        saveWorldInfo: async () => { throw new Error('disk full'); },
    });
    const arcEntry = { uid: 1, comment: 'Arc Entry', content: 'Old arc' };
    const lorebookData = lorebook([arcEntry]);

    const reconciliationResult = {
        arcOperation: { status: 'processed', entry: arcEntry, proposedContent: 'New arc content' },
        characterOperations: [],
        newCharacterProposals: [],
    };

    const result = await api.applySceneReconciliationChanges('MyBook', lorebookData, reconciliationResult);

    assert.equal(result.createdCount, 0);
    assert.equal(result.updatedCount, 0);
    assert.deepEqual(structuredClone(result.errors), ['disk full']);
    assert.equal(state.savedLorebooks.length, 0);
});

test('applySceneReconciliationChanges is a no-op when there is nothing to apply', async () => {
    const { api } = loadAddlore();
    const result = await api.applySceneReconciliationChanges('MyBook', lorebook([]), {
        arcOperation: { status: 'skipped', entry: null },
        characterOperations: [],
        newCharacterProposals: [],
    });
    assert.deepEqual(structuredClone(result), { createdCount: 0, updatedCount: 0, errors: [] });
});
