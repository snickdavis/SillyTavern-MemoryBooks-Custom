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
// callReconciliationLLM is the documented LLM call boundary (its response-parsing is a TODO
// pending prompt templates) and is mocked per-test by reassigning it on the sandbox context AFTER
// the module loads: since the sandboxed source runs as a non-strict classic script (not an ES
// module), its top-level function declarations become properties of the context's global object,
// and `reconcileSceneWithLorebook`'s bare call to `callReconciliationLLM(...)` resolves that
// identifier dynamically through the global object at call time - so overwriting
// `context.callReconciliationLLM` after the initial load is honored by later calls.

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

function loadSceneReconciliation({ callReconciliationLLM } = {}) {
    const source = readFileSync(new URL('./sceneReconciliation.js', import.meta.url), 'utf8')
        .replace(/^import[\s\S]*?;\r?\n/gm, '')
        .replace(/^export /gm, '');
    const lookups = loadAddloreLookups();
    const context = {
        console,
        sendRawCompletionRequest: async () => ({ text: '' }),
        getCharacterEntryReconciliationPrompt: ({ characterName, isArcEntry }) => `prompt:${isArcEntry ? 'arc' : characterName}`,
        getNewCharacterEntryPrompt: ({ characterName }) => `new-prompt:${characterName}`,
        getArcEntry: lookups.getArcEntry,
        getCharacterEntry: lookups.getCharacterEntry,
        filterCharactersForReconciliation: lookups.filterCharactersForReconciliation,
        detectCharacterNamesInSceneText: lookups.detectCharacterNamesInSceneText,
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'sceneReconciliation.js (sandbox)' });
    // Override the LLM boundary after load (see file header comment for why this works).
    context.callReconciliationLLM = callReconciliationLLM || (async () => ({ content: 'default mock content' }));
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

test('skips Arc reconciliation when no Arc entry exists in the lorebook', async () => {
    const reconcileSceneWithLorebook = loadSceneReconciliation();
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
});

test('processes Arc reconciliation via callReconciliationLLM when an Arc entry exists', async () => {
    const llmCalls = [];
    const reconcileSceneWithLorebook = loadSceneReconciliation({
        callReconciliationLLM: async (prompt) => {
            llmCalls.push(prompt);
            return { content: 'Updated arc content' };
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
    assert.equal(llmCalls.length, 1);
    assert.equal(result.metadata.operationsRequiringPreview, 1);
});

test('skips character reconciliation entirely when options.skipCharacterReconciliation is set', async () => {
    let charLlmCalls = 0;
    const reconcileSceneWithLorebook = loadSceneReconciliation({
        callReconciliationLLM: async (prompt) => {
            if (prompt.startsWith('prompt:')) charLlmCalls++;
            return { content: 'ignored' };
        },
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
    assert.equal(charLlmCalls, 0);
    // filterCharactersForReconciliation still runs because skipNewCharacterCreation wasn't set.
    assert.equal(result.metadata.existingCharacterCount, 1);
});

test('produces newCharacterProposals for characters with no existing entry', async () => {
    const reconcileSceneWithLorebook = loadSceneReconciliation({
        callReconciliationLLM: async (prompt) => ({
            content: `bio for ${prompt.replace('new-prompt:', '')}`,
            title: prompt.replace('new-prompt:', ''),
            keywords: ['newcomer'],
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

test('continues processing remaining characters when one LLM call throws, without aborting the run', async () => {
    const reconcileSceneWithLorebook = loadSceneReconciliation({
        callReconciliationLLM: async (prompt) => {
            if (prompt.includes('Broken')) {
                throw new Error('LLM connection reset');
            }
            return { content: `updated ${prompt}` };
        },
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
    assert.match(brokenOp.error, /LLM connection reset/);
    assert.equal(brokenOp.proposedContent, null);

    const aliceOp = result.characterOperations.find(op => op.characterName === 'Alice');
    assert.equal(aliceOp.status, 'processed');
    assert.ok(aliceOp.proposedContent.includes('updated'));

    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /Broken/);
});

test('collects an error and does not abort when new-character profile generation throws', async () => {
    const reconcileSceneWithLorebook = loadSceneReconciliation({
        callReconciliationLLM: async () => {
            throw new Error('LLM timeout');
        },
    });
    const lorebookData = { entries: {} };

    const result = await reconcileSceneWithLorebook({
        compiledScene: scene(['Bob']),
        lorebookName: 'MyBook',
        lorebookData,
        profileSettings: {},
        options: { skipArcReconciliation: true, skipCharacterReconciliation: true },
    });

    assert.equal(result.success, false);
    assert.equal(result.newCharacterProposals.length, 1);
    assert.equal(result.newCharacterProposals[0].status, 'rejected');
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /Bob/);
});

test('processes a character whose name only appears in message text via the detectCharacterNamesInSceneText union', async () => {
    const charLlmCalls = [];
    const reconcileSceneWithLorebook = loadSceneReconciliation({
        callReconciliationLLM: async (prompt) => {
            charLlmCalls.push(prompt);
            return { content: `updated ${prompt}` };
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
    assert.equal(charLlmCalls.length, 1);
});

test('includes options.manualNewCharacterNames in the candidate union, producing a newCharacterProposals entry for a brand-new name', async () => {
    const reconcileSceneWithLorebook = loadSceneReconciliation({
        callReconciliationLLM: async (prompt) => ({
            content: `bio for ${prompt.replace('new-prompt:', '')}`,
            title: prompt.replace('new-prompt:', ''),
            keywords: ['newcomer'],
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
    const charLlmCalls = [];
    const reconcileSceneWithLorebook = loadSceneReconciliation({
        callReconciliationLLM: async (prompt) => {
            charLlmCalls.push(prompt);
            return { content: `updated ${prompt}` };
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
    assert.equal(charLlmCalls.length, 1);
});
