// Copyright (C) 2024–2026 Aiko Hanasaki
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { getEntryByUid } from './memoryRegeneration.js';

// sceneReconciliation.js (and the addlore.js lookups it depends on) import directly from
// SillyTavern host paths that don't exist in this standalone repo checkout, so neither file can be
// `import`ed normally under node:test. As in addlore.test.js / stmbJobsProgress.test.js, load the
// real source text, strip import/export syntax, and run it in a vm context.
//
// getArcEntry/getCharacterEntry/filterCharactersForReconciliation are loaded for real from
// addlore.js (they're pure lookup logic) so this file exercises the real matching behavior.
//
// Scene Reconciliation now makes a SINGLE combined LLM call per run (Arc + all existing
// characters + all new characters in one request) instead of one call per item.
// callCombinedReconciliationLLM() is the documented LLM call boundary and is mocked per-test by
// reassigning it on the sandbox context AFTER the module loads: since the sandboxed source runs
// as a non-strict classic script (not an ES module), its top-level function declarations become
// properties of the context's global object, and `reconcileSceneWithLorebook`'s bare call to
// `callCombinedReconciliationLLM(...)` resolves that identifier dynamically through the global
// object at call time - so overwriting `context.callCombinedReconciliationLLM` after the initial
// load is honored by later calls.

function loadAddloreLookups() {
    const source = readFileSync(new URL('./addlore.js', import.meta.url), 'utf8')
        .replace(/^import[\s\S]*?;\r?\n/gm, '')
        .replace(/^export /gm, '');
    const context = {
        console,
        i18n: (key, fallback, params) => String(fallback ?? '').replace(/{{\s*(\w+)\s*}}/g, (_, name) =>
            (params?.[name] === undefined || params?.[name] === null) ? '' : String(params[name])),
        getEntryByUid,
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'addlore.js (sandbox)' });
    return {
        getArcEntry: context.getArcEntry,
        getCharacterEntry: context.getCharacterEntry,
        filterCharactersForReconciliation: context.filterCharactersForReconciliation,
        detectCharacterNamesInSceneText: context.detectCharacterNamesInSceneText,
    };
}

function loadSceneReconciliation({ callCombinedReconciliationLLM, getCombinedSceneReconciliationPrompt } = {}) {
    const source = readFileSync(new URL('./sceneReconciliation.js', import.meta.url), 'utf8')
        .replace(/^import[\s\S]*?;\r?\n/gm, '')
        .replace(/^export /gm, '');
    const lookups = loadAddloreLookups();
    const context = {
        console,
        sendRawCompletionRequest: async () => ({ text: '' }),
        dirtyJson: { parse: (s) => JSON.parse(s) },
        getCombinedSceneReconciliationPrompt: getCombinedSceneReconciliationPrompt || (() => 'combined-prompt'),
        getArcEntry: lookups.getArcEntry,
        getCharacterEntry: lookups.getCharacterEntry,
        filterCharactersForReconciliation: lookups.filterCharactersForReconciliation,
        detectCharacterNamesInSceneText: lookups.detectCharacterNamesInSceneText,
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'sceneReconciliation.js (sandbox)' });
    // Override the LLM boundary after load (see file header comment for why this works).
    context.callCombinedReconciliationLLM = callCombinedReconciliationLLM
        || (async () => ({ arc: null, characters: [], newCharacters: [] }));
    return context.reconcileSceneWithLorebook;
}

function scene(presentCharacterNames) {
    return { metadata: { presentCharacterNames } };
}

function sceneWithMessageText(messageTexts, presentCharacterNames = []) {
    return {
        messages: messageTexts.map(mes => ({ mes })),
        metadata: { presentCharacterNames },
    };
}

test('skips Arc reconciliation when no Arc entry exists in the lorebook, and makes no LLM call when nothing to reconcile', async () => {
    let llmCalls = 0;
    const reconcileSceneWithLorebook = loadSceneReconciliation({
        callCombinedReconciliationLLM: async () => { llmCalls++; return { arc: null, characters: [], newCharacters: [] }; },
    });
    const lorebookData = { entries: {} };

    const result = await reconcileSceneWithLorebook({
        compiledScene: scene([]),
        lorebookName: 'MyBook',
        lorebookData,
        profileSettings: {},
        options: { skipCharacterReconciliation: true, skipNewCharacterCreation: true },
    });

    assert.equal(result.arcOperation.status, 'skipped');
    assert.equal(result.arcOperation.entry, null);
    assert.deepEqual(structuredClone(result.errors), []);
    assert.equal(result.success, true);
    assert.equal(llmCalls, 0);
});

test('processes Arc reconciliation via the single combined LLM call when an Arc entry exists', async () => {
    let llmCalls = 0;
    const reconcileSceneWithLorebook = loadSceneReconciliation({
        callCombinedReconciliationLLM: async () => {
            llmCalls++;
            return { arc: { title: 'Arc', content: 'Updated arc content', keywords: [] }, characters: [], newCharacters: [] };
        },
    });
    const arcEntry = { uid: 1, comment: 'Arc Tracker', content: 'Old arc content', STMB_isArcEntry: true };
    const lorebookData = { entries: { 1: arcEntry } };

    const result = await reconcileSceneWithLorebook({
        compiledScene: scene([]),
        lorebookName: 'MyBook',
        lorebookData,
        profileSettings: {},
        options: { skipCharacterReconciliation: true, skipNewCharacterCreation: true },
    });

    assert.equal(result.arcOperation.status, 'processed');
    assert.equal(result.arcOperation.entry, arcEntry);
    assert.equal(result.arcOperation.oldContent, 'Old arc content');
    assert.equal(result.arcOperation.proposedContent, 'Updated arc content');
    assert.equal(llmCalls, 1);
    assert.equal(result.metadata.operationsRequiringPreview, 1);
});

test('skips character reconciliation entirely when options.skipCharacterReconciliation is set, but still reports metadata counts', async () => {
    let llmCalls = 0;
    const reconcileSceneWithLorebook = loadSceneReconciliation({
        callCombinedReconciliationLLM: async () => { llmCalls++; return { arc: null, characters: [], newCharacters: [] }; },
    });
    const aliceEntry = { uid: 1, comment: 'Alice', STMB_characterName: 'Alice' };
    const lorebookData = { entries: { 1: aliceEntry } };

    const result = await reconcileSceneWithLorebook({
        compiledScene: scene(['Alice']),
        lorebookName: 'MyBook',
        lorebookData,
        profileSettings: {},
        options: { skipCharacterReconciliation: true },
    });

    assert.deepEqual(structuredClone(result.characterOperations), []);
    // filterCharactersForReconciliation still runs because skipNewCharacterCreation wasn't set.
    assert.equal(result.metadata.existingCharacterCount, 1);
    // Alice is skipped and there are no new candidates, so nothing needed the LLM at all.
    assert.equal(llmCalls, 0);
});

test('produces newCharacterProposals for characters with no existing entry', async () => {
    const reconcileSceneWithLorebook = loadSceneReconciliation({
        callCombinedReconciliationLLM: async () => ({
            arc: null,
            characters: [],
            newCharacters: [{ characterName: 'Bob', title: 'Bob', content: 'bio for Bob', keywords: ['newcomer'] }],
        }),
    });
    const lorebookData = { entries: {} };

    const result = await reconcileSceneWithLorebook({
        compiledScene: scene(['Bob']),
        lorebookName: 'MyBook',
        lorebookData,
        profileSettings: {},
        options: { skipArcReconciliation: true, skipCharacterReconciliation: true },
    });

    assert.equal(result.newCharacterProposals.length, 1);
    const proposal = result.newCharacterProposals[0];
    assert.equal(proposal.characterName, 'Bob');
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.proposedContent, 'bio for Bob');
    assert.equal(proposal.proposedTitle, 'Bob');
    assert.deepEqual(structuredClone(proposal.proposedKeywords), ['newcomer']);
    assert.equal(proposal.userApproved, false);
    assert.equal(result.metadata.newCharacterCandidatesCount, 1);
});

test('a single combined call covers Arc, existing characters, and new characters together (exactly one LLM call)', async () => {
    let llmCalls = 0;
    const reconcileSceneWithLorebook = loadSceneReconciliation({
        callCombinedReconciliationLLM: async () => {
            llmCalls++;
            return {
                arc: { title: 'Arc', content: 'Updated arc content', keywords: [] },
                characters: [{ characterName: 'Alice', title: 'Alice', content: 'updated Alice content', keywords: [] }],
                newCharacters: [{ characterName: 'Bob', title: 'Bob', content: 'bio for Bob', keywords: [] }],
            };
        },
    });
    const arcEntry = { uid: 1, comment: 'Arc Tracker', content: 'Old arc content', STMB_isArcEntry: true };
    const aliceEntry = { uid: 2, comment: 'Alice', STMB_characterName: 'Alice' };
    const lorebookData = { entries: { 1: arcEntry, 2: aliceEntry } };

    const result = await reconcileSceneWithLorebook({
        compiledScene: scene(['Alice', 'Bob']),
        lorebookName: 'MyBook',
        lorebookData,
        profileSettings: {},
        options: {},
    });

    assert.equal(llmCalls, 1);
    assert.equal(result.arcOperation.status, 'processed');
    assert.equal(result.characterOperations.length, 1);
    assert.equal(result.characterOperations[0].status, 'processed');
    assert.equal(result.newCharacterProposals.length, 1);
    assert.equal(result.newCharacterProposals[0].status, 'pending');
    assert.equal(result.metadata.operationsRequiringPreview, 3);
    assert.equal(result.success, true);
});

test('a character missing from the combined response is marked error while other characters from the same response still succeed', async () => {
    const reconcileSceneWithLorebook = loadSceneReconciliation({
        callCombinedReconciliationLLM: async () => ({
            arc: null,
            // "Broken" intentionally absent from the response to simulate a malformed/missing section.
            characters: [{ characterName: 'Alice', title: 'Alice', content: 'updated Alice content', keywords: [] }],
            newCharacters: [],
        }),
    });
    const brokenEntry = { uid: 1, comment: 'Broken', STMB_characterName: 'Broken' };
    const aliceEntry = { uid: 2, comment: 'Alice', STMB_characterName: 'Alice' };
    const lorebookData = { entries: { 1: brokenEntry, 2: aliceEntry } };

    const result = await reconcileSceneWithLorebook({
        compiledScene: scene(['Broken', 'Alice']),
        lorebookName: 'MyBook',
        lorebookData,
        profileSettings: {},
        options: { skipArcReconciliation: true, skipNewCharacterCreation: true },
    });

    assert.equal(result.success, false);
    assert.equal(result.characterOperations.length, 2);

    const brokenOp = result.characterOperations.find(op => op.characterName === 'Broken');
    assert.equal(brokenOp.status, 'error');
    assert.match(brokenOp.error, /Broken/);
    assert.equal(brokenOp.proposedContent, null);

    const aliceOp = result.characterOperations.find(op => op.characterName === 'Alice');
    assert.equal(aliceOp.status, 'processed');
    assert.ok(aliceOp.proposedContent.includes('updated'));

    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /Broken/);
});

test('an Arc section with empty/malformed content in the response is marked error while character operations still succeed', async () => {
    const reconcileSceneWithLorebook = loadSceneReconciliation({
        callCombinedReconciliationLLM: async () => ({
            arc: { title: 'Arc', content: '' }, // malformed: empty content
            characters: [{ characterName: 'Alice', title: 'Alice', content: 'updated Alice content', keywords: [] }],
            newCharacters: [],
        }),
    });
    const arcEntry = { uid: 1, comment: 'Arc Tracker', content: 'Old arc content', STMB_isArcEntry: true };
    const aliceEntry = { uid: 2, comment: 'Alice', STMB_characterName: 'Alice' };
    const lorebookData = { entries: { 1: arcEntry, 2: aliceEntry } };

    const result = await reconcileSceneWithLorebook({
        compiledScene: scene(['Alice']),
        lorebookName: 'MyBook',
        lorebookData,
        profileSettings: {},
        options: { skipNewCharacterCreation: true },
    });

    assert.equal(result.arcOperation.status, 'error');
    assert.match(result.arcOperation.error, /arc/i);
    assert.equal(result.characterOperations[0].status, 'processed');
    assert.equal(result.success, false);
});

test('a total combined-LLM-call failure marks the Arc operation, all character operations, and all new-character proposals as failed with a single shared error', async () => {
    const reconcileSceneWithLorebook = loadSceneReconciliation({
        callCombinedReconciliationLLM: async () => {
            throw new Error('LLM connection reset');
        },
    });
    const arcEntry = { uid: 1, comment: 'Arc Tracker', content: 'Old arc content', STMB_isArcEntry: true };
    const aliceEntry = { uid: 2, comment: 'Alice', STMB_characterName: 'Alice' };
    const lorebookData = { entries: { 1: arcEntry, 2: aliceEntry } };

    const result = await reconcileSceneWithLorebook({
        compiledScene: scene(['Alice', 'Bob']),
        lorebookName: 'MyBook',
        lorebookData,
        profileSettings: {},
        options: {},
    });

    assert.equal(result.success, false);
    assert.equal(result.arcOperation.status, 'error');
    assert.match(result.arcOperation.error, /LLM connection reset/);

    assert.equal(result.characterOperations.length, 1);
    assert.equal(result.characterOperations[0].status, 'error');
    assert.match(result.characterOperations[0].error, /LLM connection reset/);

    assert.equal(result.newCharacterProposals.length, 1);
    assert.equal(result.newCharacterProposals[0].status, 'rejected');

    // Exactly one shared error message for the whole failed call, not one per operation.
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /LLM connection reset/);
});

test('processes a character whose name only appears in message text via the detectCharacterNamesInSceneText union', async () => {
    let llmCalls = 0;
    const reconcileSceneWithLorebook = loadSceneReconciliation({
        callCombinedReconciliationLLM: async () => {
            llmCalls++;
            return {
                arc: null,
                characters: [{ characterName: 'Zephyr', title: 'Zephyr', content: 'updated Zephyr content', keywords: [] }],
                newCharacters: [],
            };
        },
    });
    const zephyrEntry = { uid: 1, comment: 'Zephyr', STMB_characterName: 'Zephyr' };
    const lorebookData = { entries: { 1: zephyrEntry } };

    const result = await reconcileSceneWithLorebook({
        compiledScene: sceneWithMessageText(['The narrator describes Zephyr entering the hall.']),
        lorebookName: 'MyBook',
        lorebookData,
        profileSettings: {},
        options: { skipArcReconciliation: true, skipNewCharacterCreation: true },
    });

    assert.equal(result.metadata.totalCharactersInScene, 1);
    assert.equal(result.characterOperations.length, 1);
    assert.equal(result.characterOperations[0].characterName, 'Zephyr');
    assert.equal(result.characterOperations[0].status, 'processed');
    assert.equal(llmCalls, 1);
});

test('includes options.manualNewCharacterNames in the candidate union, producing a newCharacterProposals entry for a brand-new name', async () => {
    const reconcileSceneWithLorebook = loadSceneReconciliation({
        callCombinedReconciliationLLM: async () => ({
            arc: null,
            characters: [],
            newCharacters: [{ characterName: 'Nadia', title: 'Nadia', content: 'bio for Nadia', keywords: ['newcomer'] }],
        }),
    });
    const lorebookData = { entries: {} };

    const result = await reconcileSceneWithLorebook({
        compiledScene: scene([]),
        lorebookName: 'MyBook',
        lorebookData,
        profileSettings: {},
        options: {
            skipArcReconciliation: true,
            skipCharacterReconciliation: true,
            manualNewCharacterNames: ['Nadia'],
        },
    });

    assert.equal(result.metadata.totalCharactersInScene, 1);
    assert.equal(result.newCharacterProposals.length, 1);
    const proposal = result.newCharacterProposals[0];
    assert.equal(proposal.characterName, 'Nadia');
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.proposedContent, 'bio for Nadia');
});

test('a manualNewCharacterNames entry matching an existing entry is bucketed as existing, not a new proposal', async () => {
    let llmCalls = 0;
    const reconcileSceneWithLorebook = loadSceneReconciliation({
        callCombinedReconciliationLLM: async () => {
            llmCalls++;
            return {
                arc: null,
                characters: [{ characterName: 'Alice', title: 'Alice', content: 'updated Alice content', keywords: [] }],
                newCharacters: [],
            };
        },
    });
    const aliceEntry = { uid: 1, comment: 'Alice', STMB_characterName: 'Alice' };
    const lorebookData = { entries: { 1: aliceEntry } };

    const result = await reconcileSceneWithLorebook({
        compiledScene: scene([]),
        lorebookName: 'MyBook',
        lorebookData,
        profileSettings: {},
        options: {
            skipArcReconciliation: true,
            skipNewCharacterCreation: true,
            manualNewCharacterNames: ['Alice'],
        },
    });

    assert.equal(result.newCharacterProposals.length, 0);
    assert.equal(result.characterOperations.length, 1);
    assert.equal(result.characterOperations[0].characterName, 'Alice');
    assert.equal(llmCalls, 1);
});

test('builds the combined prompt exactly once per run, passing arcEntry/existingCharacters/newCharacterNames through', async () => {
    const promptCalls = [];
    const reconcileSceneWithLorebook = loadSceneReconciliation({
        getCombinedSceneReconciliationPrompt: (args) => { promptCalls.push(args); return 'combined-prompt'; },
        callCombinedReconciliationLLM: async (prompt) => {
            assert.equal(prompt, 'combined-prompt');
            return {
                arc: { title: 'Arc', content: 'Updated arc content', keywords: [] },
                characters: [{ characterName: 'Alice', title: 'Alice', content: 'updated Alice content', keywords: [] }],
                newCharacters: [{ characterName: 'Bob', title: 'Bob', content: 'bio for Bob', keywords: [] }],
            };
        },
    });
    const arcEntry = { uid: 1, comment: 'Arc Tracker', content: 'Old arc content', STMB_isArcEntry: true };
    const aliceEntry = { uid: 2, comment: 'Alice', STMB_characterName: 'Alice' };
    const lorebookData = { entries: { 1: arcEntry, 2: aliceEntry } };

    await reconcileSceneWithLorebook({
        compiledScene: scene(['Alice', 'Bob']),
        lorebookName: 'MyBook',
        lorebookData,
        profileSettings: {},
        options: {},
    });

    assert.equal(promptCalls.length, 1);
    assert.equal(promptCalls[0].arcEntry, arcEntry);
    assert.equal(promptCalls[0].existingCharacters.length, 1);
    assert.equal(promptCalls[0].existingCharacters[0].name, 'Alice');
    assert.deepEqual(structuredClone(promptCalls[0].newCharacterNames), ['Bob']);
});
