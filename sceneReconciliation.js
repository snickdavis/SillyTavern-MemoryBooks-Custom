// Copyright (C) 2024–2026 Aiko Hanasaki
// SPDX-License-Identifier: AGPL-3.0-only

import { getArcEntry, getCharacterEntry, filterCharactersForReconciliation, detectCharacterNamesInSceneText } from './addlore.js';
import { sendRawCompletionRequest, parseAIJsonResponse } from './stmemory.js';
import { getCharacterEntryReconciliationPrompt, getNewCharacterEntryPrompt } from './templatesArcPrompts.js';
import { getCurrentApiInfo, normalizeCompletionSource } from './utils.js';
import { extension_settings } from '../../../extensions.js';
import { oai_settings } from '../../../openai.js';

const MODULE_NAME = 'STMemoryBooks-SceneReconciliation';

/** Mirrors the AIResponseError naming convention used in stmemory.js (not exported from there). */
class ReconciliationAIError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ReconciliationAIError';
    }
}

/**
 * Sends a Scene Reconciliation prompt to the LLM and parses the JSON response.
 *
 * Mirrors stmemory.js's generateMemoryWithAI() conventions: resolves connection settings from
 * `profile.effectiveConnection || profile.connection`, normalizes the completion source the same
 * way (normalizeCompletionSource(conn.api || getCurrentApiInfo().api)), and forwards STMB's
 * max-tokens override / abort signal the same way. Response parsing reuses stmemory.js's
 * parseAIJsonResponse() (JSON-block extraction + dirty-json repair + required-field validation)
 * since the reconciliation response shape ({ title, content, keywords }) is identical to the
 * memory generation response shape it already validates.
 *
 * @param {string} prompt
 * @param {Object} profileSettings - A memory-generation profile (same shape used by stmemory.js)
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{content: string, title?: string, keywords?: string[], full?: Object}>}
 * @throws {ReconciliationAIError}
 */
export async function callReconciliationLLM(prompt, profileSettings, options = {}) {
    const conn = profileSettings?.effectiveConnection || profileSettings?.connection || {};
    const apiType = normalizeCompletionSource(conn.api || getCurrentApiInfo().api);

    const extra = {};
    const stmbMaxTokensRaw = extension_settings?.STMemoryBooks?.moduleSettings?.maxTokens;
    const stmbMaxTokens = Number.parseInt(stmbMaxTokensRaw, 10);
    if (Number.isFinite(stmbMaxTokens) && stmbMaxTokens > 0) {
        extra.max_tokens = stmbMaxTokens;
    } else if (oai_settings?.openai_max_tokens) {
        extra.max_tokens = oai_settings.openai_max_tokens;
    }

    let aiResponse;
    try {
        aiResponse = await sendRawCompletionRequest({
            model: conn.model,
            prompt,
            temperature: conn.temperature,
            api: apiType,
            endpoint: conn.endpoint,
            apiKey: conn.apiKey,
            connectionProfileId: conn.connectionProfileId,
            extra,
            reverseProxy: !!conn.reverseProxy,
            signal: options?.signal || null,
            useChatCompletionService: profileSettings?.useChatCompletionService === true && apiType !== 'full-manual',
            chatCompletionPreset: profileSettings?.chatCompletionPreset || '',
        });
    } catch (error) {
        throw new ReconciliationAIError(`Scene reconciliation LLM call failed: ${error?.message || error}`);
    }

    try {
        const jsonResult = parseAIJsonResponse(aiResponse?.text);
        const content = jsonResult.content || jsonResult.summary || jsonResult.memory_content || '';
        if (!content) {
            throw new ReconciliationAIError('Scene reconciliation response is missing a content field.');
        }
        return {
            content,
            title: jsonResult.title,
            keywords: Array.isArray(jsonResult.keywords) ? jsonResult.keywords : [],
            full: aiResponse?.full,
        };
    } catch (error) {
        if (error?.name === 'ReconciliationAIError') {
            throw error;
        }
        throw new ReconciliationAIError(`Scene reconciliation response was not valid JSON: ${error?.message || error}`);
    }
}

/**
 * Orchestrates Scene Reconciliation against a compiled scene: Arc entry reconciliation,
 * existing character entry reconciliation, and new-character profile generation.
 *
 * Must NOT write anything to the lorebook - this only produces proposals. Writing happens
 * later via applySceneReconciliationChanges() in addlore.js, after user approval via a
 * preview UI (not part of this task).
 *
 * Continues processing other characters even if one LLM call errors - errors are collected
 * into `errors[]` and the affected operation's status is set to an error/rejected state; the
 * whole run is never aborted early.
 *
 * @param {Object} params
 * @param {Object} params.compiledScene - Output of chatcompile.js's compileScene()
 * @param {string} params.lorebookName
 * @param {Object} params.lorebookData
 * @param {Object} params.profileSettings - Memory-generation profile (connection settings, etc.)
 * @param {Object} [params.options]
 * @param {boolean} [params.options.skipArcReconciliation]
 * @param {boolean} [params.options.skipCharacterReconciliation]
 * @param {boolean} [params.options.skipNewCharacterCreation]
 * @param {AbortSignal} [params.options.signal]
 * @param {Object} [params.options.filterOptions] - Forwarded to filterCharactersForReconciliation() (e.g. excludePatterns)
 * @returns {Promise<{
 *   success: boolean,
 *   arcOperation: {status: 'skipped'|'processed'|'error', entry: Object|null, oldContent: string|null, proposedContent: string|null, error: string|null},
 *   characterOperations: Array<{characterName: string, status: string, entry: Object, oldContent: string, proposedContent: string|null, operationType: 'update', error: string|null}>,
 *   newCharacterProposals: Array<{characterName: string, status: 'pending'|'created'|'rejected', entry: null, proposedContent: string|null, proposedTitle: string, proposedKeywords: string[], userApproved: boolean, userEdits: Object|null}>,
 *   metadata: {totalCharactersInScene: number, existingCharacterCount: number, newCharacterCandidatesCount: number, operationsRequiringPreview: number},
 *   errors: string[],
 * }>}
 */
export async function reconcileSceneWithLorebook({ compiledScene, lorebookName, lorebookData, profileSettings, options = {} } = {}) {
    console.log(`${MODULE_NAME}: Starting scene reconciliation against "${lorebookName}"`);
    const errors = [];
    const presentCharacterNames = Array.isArray(compiledScene?.metadata?.presentCharacterNames)
        ? compiledScene.metadata.presentCharacterNames
        : [];
    // Handles single-narrator-bot chats: none of the tagged characters are ever message senders,
    // so presentCharacterNames alone stays empty there - typeof-guarded since the test sandbox
    // doesn't stub this addlore.js export (see sceneReconciliation.test.js header comment).
    const detectedCharacterNames = typeof detectCharacterNamesInSceneText === 'function'
        ? detectCharacterNamesInSceneText(compiledScene, lorebookData, options)
        : [];
    const characterNames = [];
    const seenCharacterNamesLower = new Set();
    for (const name of [...presentCharacterNames, ...detectedCharacterNames]) {
        const trimmed = String(name || '').trim();
        const lower = trimmed.toLowerCase();
        if (!trimmed || seenCharacterNamesLower.has(lower)) {
            continue;
        }
        seenCharacterNamesLower.add(lower);
        characterNames.push(trimmed);
    }

    const result = {
        success: true,
        arcOperation: { status: 'skipped', entry: null, oldContent: null, proposedContent: null, error: null },
        characterOperations: [],
        newCharacterProposals: [],
        metadata: {
            totalCharactersInScene: characterNames.length,
            existingCharacterCount: 0,
            newCharacterCandidatesCount: 0,
            operationsRequiringPreview: 0,
        },
        errors,
    };

    // 1. Arc entry reconciliation
    if (!options.skipArcReconciliation) {
        try {
            const { entry: arcEntry } = getArcEntry(lorebookData, lorebookData);
            if (!arcEntry) {
                result.arcOperation.status = 'skipped';
            } else {
                const oldContent = arcEntry.content || '';
                const prompt = getCharacterEntryReconciliationPrompt({
                    entry: arcEntry,
                    compiledScene,
                    characterName: null,
                    isArcEntry: true,
                });
                const llmResult = await callReconciliationLLM(prompt, profileSettings, { signal: options.signal });
                result.arcOperation = {
                    status: 'processed',
                    entry: arcEntry,
                    oldContent,
                    proposedContent: llmResult.content,
                    error: null,
                };
                result.metadata.operationsRequiringPreview++;
            }
        } catch (error) {
            const message = `Arc entry reconciliation failed: ${error?.message || error}`;
            result.arcOperation = {
                status: 'error',
                entry: result.arcOperation.entry,
                oldContent: result.arcOperation.oldContent,
                proposedContent: null,
                error: message,
            };
            errors.push(message);
        }
    }

    // 2 & 3. Existing-character reconciliation and new-character profile generation
    if (!options.skipCharacterReconciliation || !options.skipNewCharacterCreation) {
        const filtered = filterCharactersForReconciliation(
            characterNames,
            lorebookData,
            options.filterOptions || {},
        );
        result.metadata.existingCharacterCount = filtered.existing.length;
        result.metadata.newCharacterCandidatesCount = filtered.new.length;

        if (!options.skipCharacterReconciliation) {
            for (const { name, entry } of filtered.existing) {
                const oldContent = entry.content || '';
                try {
                    const prompt = getCharacterEntryReconciliationPrompt({
                        entry,
                        compiledScene,
                        characterName: name,
                        isArcEntry: false,
                    });
                    const llmResult = await callReconciliationLLM(prompt, profileSettings, { signal: options.signal });
                    result.characterOperations.push({
                        characterName: name,
                        status: 'processed',
                        entry,
                        oldContent,
                        proposedContent: llmResult.content,
                        operationType: 'update',
                        error: null,
                    });
                    result.metadata.operationsRequiringPreview++;
                } catch (error) {
                    const message = `Character reconciliation failed for "${name}": ${error?.message || error}`;
                    result.characterOperations.push({
                        characterName: name,
                        status: 'error',
                        entry,
                        oldContent,
                        proposedContent: null,
                        operationType: 'update',
                        error: message,
                    });
                    errors.push(message);
                }
            }
        }

        if (!options.skipNewCharacterCreation) {
            for (const { name } of filtered.new) {
                try {
                    const prompt = getNewCharacterEntryPrompt({ characterName: name, compiledScene });
                    const llmResult = await callReconciliationLLM(prompt, profileSettings, { signal: options.signal });
                    result.newCharacterProposals.push({
                        characterName: name,
                        status: 'pending',
                        entry: null,
                        proposedContent: llmResult.content,
                        proposedTitle: llmResult.title || name,
                        proposedKeywords: llmResult.keywords || [],
                        userApproved: false,
                        userEdits: null,
                    });
                    result.metadata.operationsRequiringPreview++;
                } catch (error) {
                    // No dedicated 'error' state exists in the newCharacterProposals status enum
                    // (pending|created|rejected) - 'rejected' is reused here for generation failures
                    // so the proposal is excluded from applySceneReconciliationChanges() by default.
                    const message = `New character profile generation failed for "${name}": ${error?.message || error}`;
                    result.newCharacterProposals.push({
                        characterName: name,
                        status: 'rejected',
                        entry: null,
                        proposedContent: null,
                        proposedTitle: name,
                        proposedKeywords: [],
                        userApproved: false,
                        userEdits: null,
                    });
                    errors.push(message);
                }
            }
        }
    }

    result.success = errors.length === 0;
    return result;
}
