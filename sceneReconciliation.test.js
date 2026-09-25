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
// Scene Reconciliation makes ONE LLM call PER lorebook entry update/creation (Arc entry, each
// existing character, each new character) - restored per-item architecture (a prior single
// combined-call approach hit real completion-token-budget failures in production and was
// reverted). callReconciliationLLM() is the documented single-item LLM call boundary and is
// mocked per-test by reassigning it on the sandbox context AFTER the module loads: since the
// sandboxed source runs as a non-strict classic script (not an ES module), its top-level function
// declarations become properties of the context's global object, and
// `reconcileSceneWithLorebook`'s bare call to `callReconciliationLLM(...)` resolves that
// identifier dynamically through the global object at call time - so overwriting
// `context.callReconciliationLLM` after the initial load is honored by later calls.
//
// The default stub prompt builders (getArcReconciliationPrompt/getCharacterReconciliationPrompt/
// getNewCharacterEntryPrompt) return distinguishable tagged strings ('arc-prompt',
// 'character-prompt:<name>', 'new-character-prompt:<name>') so a single generic
// callReconciliationLLM mock can tell which item is being requested without needing the real
// templatesArcPrompts.js prompt text (that file also imports host-relative paths and isn't
// loaded here).

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

function loadSceneReconciliation({
    callReconciliationLLM,
    getArcReconciliationPrompt,
    getCharacterReconciliationPrompt,
    getNewCharacterEntryPrompt,
} = {}) {
    const source = readFileSync(new URL('./sceneReconciliation.js', import.meta.url), 'utf8')
        .replace(/^import[\s\S]*?;\r?\n/gm, '')
        .replace(/^export /gm, '');
    const lookups = loadAddloreLookups();
    const context = {
        console,
        sendRawCompletionRequest: async () => ({ text: '' }),
        dirtyJson: { parse: (s) => JSON.parse(s) },
        getArcReconciliationPrompt: getArcReconciliationPrompt || (() => 'arc-prompt'),
        getCharacterReconciliationPrompt: getCharacterReconciliationPrompt || (({ characterName }) => `character-prompt:${characterName}`),
        getNewCharacterEntryPrompt: getNewCharacterEntryPrompt || (({ characterName }) => `new-character-prompt:${characterName}`),
        getArcEntry: lookups.getArcEntry,
        getCharacterEntry: lookups.getCharacterEntry,
        filterCharactersForReconciliation: lookups.filterCharactersForReconciliation,
        detectCharacterNamesInSceneText: lookups.detectCharacterNamesInSceneText,
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'sceneReconciliation.js (sandbox)' });
    // Override the LLM boundary after load (see file header comment for why this works).
    context.callReconciliationLLM = callReconciliationLLM
        || (async () => ({ title: '', content: 'default content', keywords: [] }));
    return context.reconcileSceneWithLorebook;
}

/**
 * Builds a callReconciliationLLM mock that dispatches on the tagged prompt strings produced by
 * the default stub prompt builders, so each test can configure per-item responses/errors by name
 * without needing to parse real prompt text.
 * @param {Object} [config]
 * @param {Object|Error} [config.arc] - Response object or Error to throw for the Arc prompt
 * @param {Object<string, Object|Error>} [config.characters] - Keyed by characterName
 * @param {Object<string, Object|Error>} [config.newCharacters] - Keyed by characterName
 * @param {(prompt: string) => void} [config.onCall] - Called with every prompt received (for counting/asserting call order)
 */
function makeCallMock({ arc, characters = {}, newCharacters = {}, onCall } = {}) {
    return async (prompt) => {
        onCall?.(prompt);
        if (prompt === 'arc-prompt') {
            if (arc instanceof Error) throw arc;
            if (!arc) throw new Error('No mock response configured for arc-prompt');
            return arc;
        }
        if (prompt.startsWith('character-prompt:')) {
            const name = prompt.slice('character-prompt:'.length);
            const resp = characters[name];
            if (resp instanceof Error) throw resp;
            if (!resp) throw new Error(`No mock response configured for character "${name}"`);
            return resp;
        }
        if (prompt.startsWith('new-character-prompt:')) {
            const name = prompt.slice('new-character-prompt:'.length);
            const resp = newCharacters[name];
            if (resp instanceof Error) throw resp;
            if (!resp) throw new Error(`No mock response configured for new character "${name}"`);
            return resp;
        }
        throw new Error(`Unexpected prompt passed to callReconciliationLLM: ${prompt}`);
    };
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
        callReconciliationLLM: makeCallMock({ onCall: () => { llmCalls++; } }),
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

test('processes Arc reconciliation via its own single LLM call when an Arc entry exists', async () => {
    let llmCalls = 0;
    const reconcileSceneWithLorebook = loadSceneReconciliation({
        callReconciliationLLM: makeCallMock({
            arc: { title: 'Arc', content: 'Updated arc content', keywords: [] },
            onCall: () => { llmCalls++; },
        }),
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
        callReconciliationLLM: makeCallMock({ onCall: () => { llmCalls++; } }),
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

test('produces newCharacterProposals for characters with no existing entry, via their own single LLM call', async () => {
    let llmCalls = 0;
    const reconcileSceneWithLorebook = loadSceneReconciliation({
        callReconciliationLLM: makeCallMock({
            newCharacters: { Bob: { title: 'Bob', content: 'bio for Bob', keywords: ['newcomer'] } },
            onCall: () => { llmCalls++; },
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
    assert.equal(llmCalls, 1);
});

test('reconciles Arc, an existing character, and a new character together using one LLM call per item (three calls total)', async () => {
    let llmCalls = 0;
    const reconcileSceneWithLorebook = loadSceneReconciliation({
        callReconciliationLLM: makeCallMock({
            arc: { title: 'Arc', content: 'Updated arc content', keywords: [] },
            characters: { Alice: { title: 'Alice', content: 'updated Alice content', keywords: [] } },
            newCharacters: { Bob: { title: 'Bob', content: 'bio for Bob', keywords: [] } },
            onCall: () => { llmCalls++; },
        }),
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

    assert.equal(llmCalls, 3);
    assert.equal(result.arcOperation.status, 'processed');
    assert.equal(result.characterOperations.length, 1);
    assert.equal(result.characterOperations[0].status, 'processed');
    assert.equal(result.newCharacterProposals.length, 1);
    assert.equal(result.newCharacterProposals[0].status, 'pending');
    assert.equal(result.metadata.operationsRequiringPreview, 3);
    assert.equal(result.success, true);
});

test('one existing character\'s LLM call failing is caught, marks only that operation as error, and processing continues for the rest', async () => {
    const reconcileSceneWithLorebook = loadSceneReconciliation({
        callReconciliationLLM: makeCallMock({
            characters: {
                Broken: new Error('model refused'),
                Alice: { title: 'Alice', content: 'updated Alice content', keywords: [] },
            },
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
    assert.match(brokenOp.error, /model refused/);
    assert.equal(brokenOp.proposedContent, null);

    const aliceOp = result.characterOperations.find(op => op.characterName === 'Alice');
    assert.equal(aliceOp.status, 'processed');
    assert.ok(aliceOp.proposedContent.includes('updated'));

    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /Broken/);
});

test('the Arc entry\'s LLM call failing is caught and marks only the Arc operation as error, while character reconciliation still succeeds', async () => {
    const reconcileSceneWithLorebook = loadSceneReconciliation({
        callReconciliationLLM: makeCallMock({
            arc: new Error('response was not valid JSON'),
            characters: { Alice: { title: 'Alice', content: 'updated Alice content', keywords: [] } },
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
    assert.match(result.arcOperation.error, /Arc entry reconciliation failed/);
    assert.match(result.arcOperation.error, /not valid JSON/);
    assert.equal(result.characterOperations[0].status, 'processed');
    assert.equal(result.success, false);
});

test('one new character\'s LLM call failing is rejected while sibling new-character proposals from other calls still succeed', async () => {
    const reconcileSceneWithLorebook = loadSceneReconciliation({
        callReconciliationLLM: makeCallMock({
            newCharacters: {
                Bob: { title: 'Bob', content: 'bio for Bob', keywords: [] },
                Carol: new Error('LLM connection reset'),
            },
        }),
    });
    const lorebookData = { entries: {} };

    const result = await reconcileSceneWithLorebook({
        compiledScene: scene(['Bob', 'Carol']),
        lorebookName: 'MyBook',
        lorebookData,
        profileSettings: {},
        options: { skipArcReconciliation: true, skipCharacterReconciliation: true },
    });

    assert.equal(result.success, false);
    assert.equal(result.newCharacterProposals.length, 2);

    const bobProposal = result.newCharacterProposals.find(p => p.characterName === 'Bob');
    assert.equal(bobProposal.status, 'pending');
    assert.equal(bobProposal.proposedContent, 'bio for Bob');

    const carolProposal = result.newCharacterProposals.find(p => p.characterName === 'Carol');
    assert.equal(carolProposal.status, 'rejected');
    assert.equal(carolProposal.proposedContent, null);

    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /Carol/);
    assert.match(result.errors[0], /LLM connection reset/);
});

test('processes a character whose name only appears in message text via the detectCharacterNamesInSceneText union', async () => {
    let llmCalls = 0;
    const reconcileSceneWithLorebook = loadSceneReconciliation({
        callReconciliationLLM: makeCallMock({
            characters: { Zephyr: { title: 'Zephyr', content: 'updated Zephyr content', keywords: [] } },
            onCall: () => { llmCalls++; },
        }),
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
        callReconciliationLLM: makeCallMock({
            newCharacters: { Nadia: { title: 'Nadia', content: 'bio for Nadia', keywords: ['newcomer'] } },
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
        callReconciliationLLM: makeCallMock({
            characters: { Alice: { title: 'Alice', content: 'updated Alice content', keywords: [] } },
            onCall: () => { llmCalls++; },
        }),
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

test('builds a dedicated prompt per item, passing the expected arguments to each prompt-builder function', async () => {
    const arcPromptCalls = [];
    const characterPromptCalls = [];
    const newCharacterPromptCalls = [];
    const reconcileSceneWithLorebook = loadSceneReconciliation({
        getArcReconciliationPrompt: (args) => { arcPromptCalls.push(args); return 'arc-prompt'; },
        getCharacterReconciliationPrompt: (args) => { characterPromptCalls.push(args); return `character-prompt:${args.characterName}`; },
        getNewCharacterEntryPrompt: (args) => { newCharacterPromptCalls.push(args); return `new-character-prompt:${args.characterName}`; },
        callReconciliationLLM: makeCallMock({
            arc: { title: 'Arc', content: 'Updated arc content', keywords: [] },
            characters: { Alice: { title: 'Alice', content: 'updated Alice content', keywords: [] } },
            newCharacters: { Bob: { title: 'Bob', content: 'bio for Bob', keywords: [] } },
        }),
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

    assert.equal(arcPromptCalls.length, 1);
    assert.equal(arcPromptCalls[0].arcEntry, arcEntry);

    assert.equal(characterPromptCalls.length, 1);
    assert.equal(characterPromptCalls[0].entry, aliceEntry);
    assert.equal(characterPromptCalls[0].characterName, 'Alice');

    assert.equal(newCharacterPromptCalls.length, 1);
    assert.equal(newCharacterPromptCalls[0].characterName, 'Bob');
});
