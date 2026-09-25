// Copyright (C) 2024–2026 Aiko Hanasaki
// SPDX-License-Identifier: AGPL-3.0-only

import { getArcEntry, getCharacterEntry, filterCharactersForReconciliation, detectCharacterNamesInSceneText } from './addlore.js';
import { sendRawCompletionRequest } from './stmemory.js';
import { getCombinedSceneReconciliationPrompt } from './templatesArcPrompts.js';
import { getCurrentApiInfo, normalizeCompletionSource } from './utils.js';
import { extension_settings } from '../../../extensions.js';
import { oai_settings } from '../../../openai.js';
import dirtyJson from 'dirty-json';

const MODULE_NAME = 'STMemoryBooks-SceneReconciliation';

/** Mirrors the AIResponseError naming convention used in stmemory.js (not exported from there). */
class ReconciliationAIError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ReconciliationAIError';
    }
}

/**
 * Resolves connection/token settings and sends a single Scene Reconciliation prompt to the LLM,
 * returning the raw response text. Shared by callCombinedReconciliationLLM() so the
 * connection-resolution/max-tokens/abort-signal setup only lives in one place.
 *
 * Mirrors stmemory.js's generateMemoryWithAI() conventions: resolves connection settings from
 * `profile.effectiveConnection || profile.connection`, normalizes the completion source the same
 * way (normalizeCompletionSource(conn.api || getCurrentApiInfo().api)), and forwards STMB's
 * max-tokens override / abort signal the same way.
 *
 * @param {string} prompt
 * @param {Object} profileSettings - A memory-generation profile (same shape used by stmemory.js)
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string>} Raw response text
 * @throws {ReconciliationAIError}
 */
async function sendReconciliationLLMRequest(prompt, profileSettings, options = {}) {
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

    try {
        const aiResponse = await sendRawCompletionRequest({
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
        return aiResponse?.text;
    } catch (error) {
        throw new ReconciliationAIError(`Scene reconciliation LLM call failed: ${error?.message || error}`);
    }
}

function normalizeResponseText(s) {
    return String(s || '')
        .replace(/\r\n/g, '\n')
        .replace(/^\uFEFF/, '')
        .replace(/[\u0000-\u001F\u200B-\u200D\u2060]/g, '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .trim();
}

function extractFencedJsonBlocks(s) {
    const re = /```([\w-]*)\s*([\s\S]*?)```/g;
    const out = [];
    let m;
    while ((m = re.exec(s)) !== null) {
        out.push((m[2] || '').trim());
    }
    return out;
}

function extractBalancedJsonSubstring(s) {
    const start = s.search(/[\{\[]/);
    if (start === -1) return null;
    const open = s[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
            if (esc) { esc = false; }
            else if (ch === '\\') { esc = true; }
            else if (ch === '"') { inStr = false; }
            continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === open) depth++;
        else if (ch === close) {
            depth--;
            if (depth === 0) {
                return s.slice(start, i + 1).trim();
            }
        }
    }
    return null;
}

/**
 * Parses the combined Scene Reconciliation JSON response ({ arc, characters, newCharacters }).
 * Self-contained local equivalent of stmemory.js's parseAIJsonResponse() extraction/repair
 * pipeline (fenced-block -> whole-text -> balanced-substring candidates, JSON.parse then
 * dirty-json repair fallback) - not reused directly because that function validates a single-item
 * {content,title,keywords} shape and would reject this compound multi-section shape.
 *
 * @param {string} rawText
 * @returns {{arc: Object|null, characters: Array, newCharacters: Array}}
 * @throws {ReconciliationAIError}
 */
function parseCombinedReconciliationResponse(rawText) {
    const normalized = normalizeResponseText(rawText);
    if (!normalized) {
        throw new ReconciliationAIError('Scene reconciliation response is empty.');
    }

    const candidates = [...extractFencedJsonBlocks(normalized), normalized];
    const balanced = extractBalancedJsonSubstring(normalized);
    if (balanced) candidates.push(balanced);
    const uniqueCandidates = [...new Set(candidates)];

    for (const candidate of uniqueCandidates) {
        for (const parse of [(s) => JSON.parse(s), (s) => dirtyJson.parse(s)]) {
            try {
                const parsed = parse(candidate);
                const isCombinedShape = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                    && ('arc' in parsed || 'characters' in parsed || 'newCharacters' in parsed);
                if (isCombinedShape) {
                    return {
                        arc: parsed.arc && typeof parsed.arc === 'object' ? parsed.arc : null,
                        characters: Array.isArray(parsed.characters) ? parsed.characters : [],
                        newCharacters: Array.isArray(parsed.newCharacters) ? parsed.newCharacters : [],
                    };
                }
            } catch {
                // try next candidate/parser
            }
        }
    }

    throw new ReconciliationAIError('Scene reconciliation response was not valid JSON.');
}

/**
 * Sends the combined Scene Reconciliation prompt to the LLM and parses the compound JSON
 * response. This is the single LLM-call boundary used by reconcileSceneWithLorebook() - one
 * call covers the Arc entry plus every existing/new character, replacing the former
 * one-call-per-item approach.
 *
 * @param {string} prompt
 * @param {Object} profileSettings - A memory-generation profile (same shape used by stmemory.js)
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{arc: Object|null, characters: Array, newCharacters: Array}>}
 * @throws {ReconciliationAIError}
 */
export async function callCombinedReconciliationLLM(prompt, profileSettings, options = {}) {
    const rawText = await sendReconciliationLLMRequest(prompt, profileSettings, options);
    return parseCombinedReconciliationResponse(rawText);
}

/**
 * Finds the item in a combined-response array (response.characters / response.newCharacters)
 * matching a given character name, case-insensitively, and validates it has usable content.
 * @param {Array} items
 * @param {string} name
 * @returns {Object|null} The matched item if present and valid (has a non-empty content string), else null
 */
function findValidResponseItem(items, name) {
    const lower = String(name || '').trim().toLowerCase();
    const match = (Array.isArray(items) ? items : []).find(
        (item) => String(item?.characterName || '').trim().toLowerCase() === lower,
    );
    if (!match || typeof match.content !== 'string' || !match.content.trim()) {
        return null;
    }
    return match;
}

/**
 * Orchestrates Scene Reconciliation against a compiled scene: Arc entry reconciliation,
 * existing character entry reconciliation, and new-character profile generation.
 *
 * Must NOT write anything to the lorebook - this only produces proposals. Writing happens
 * later via applySceneReconciliationChanges() in addlore.js, after user approval via a
 * preview UI (not part of this task).
 *
 * Makes a SINGLE combined LLM call covering the Arc entry plus every existing/new character
 * (see getCombinedSceneReconciliationPrompt() / callCombinedReconciliationLLM()). Per-item fault
 * isolation is preserved at the distribution stage: if the response is missing or malformed for
 * one specific character, only that character's operation/proposal is marked as failed - it does
 * not null out the rest of the response. Only a total call failure (network error, completely
 * unparseable response) marks every attempted operation as failed.
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
 * @param {string[]} [params.options.manualNewCharacterNames=[]] - Explicit user-provided candidate
 *   names (replaces automatic heuristic new-character guessing). Unioned with
 *   presentCharacterNames and detectCharacterNamesInSceneText()'s existing-entry matches before
 *   filterCharactersForReconciliation() buckets them into existing vs. new - a manual name that
 *   already has an entry is simply bucketed as existing (harmless).
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
    const manualNewCharacterNames = Array.isArray(options.manualNewCharacterNames)
        ? options.manualNewCharacterNames
        : [];
    const characterNames = [];
    const seenCharacterNamesLower = new Set();
    for (const name of [...presentCharacterNames, ...detectedCharacterNames, ...manualNewCharacterNames]) {
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

    // 1. Resolve the Arc entry (unless skipped).
    let arcEntryForPrompt = null;
    if (!options.skipArcReconciliation) {
        try {
            const { entry: arcEntry } = getArcEntry(lorebookData, lorebookData);
            if (arcEntry) {
                arcEntryForPrompt = arcEntry;
                result.arcOperation.entry = arcEntry;
                result.arcOperation.oldContent = arcEntry.content || '';
            }
        } catch (error) {
            const message = `Arc entry lookup failed: ${error?.message || error}`;
            result.arcOperation = { status: 'error', entry: null, oldContent: null, proposedContent: null, error: message };
            errors.push(message);
        }
    }

    // 2. Resolve existing/new character buckets (kept as-is - unrelated to call-consolidation).
    let existingCharactersToSend = [];
    let newCharacterNamesToSend = [];
    if (!options.skipCharacterReconciliation || !options.skipNewCharacterCreation) {
        const filtered = filterCharactersForReconciliation(
            characterNames,
            lorebookData,
            options.filterOptions || {},
        );
        result.metadata.existingCharacterCount = filtered.existing.length;
        result.metadata.newCharacterCandidatesCount = filtered.new.length;

        if (!options.skipCharacterReconciliation) {
            existingCharactersToSend = filtered.existing;
        }
        if (!options.skipNewCharacterCreation) {
            newCharacterNamesToSend = filtered.new.map(({ name }) => name);
        }
    }

    // 3. Nothing to reconcile - skip the LLM call entirely.
    const hasArcToProcess = result.arcOperation.status !== 'error' && !!arcEntryForPrompt;
    if (!hasArcToProcess && existingCharactersToSend.length === 0 && newCharacterNamesToSend.length === 0) {
        result.success = errors.length === 0;
        return result;
    }

    // 4. Build and send ONE combined prompt covering everything above.
    const prompt = getCombinedSceneReconciliationPrompt({
        arcEntry: hasArcToProcess ? arcEntryForPrompt : null,
        existingCharacters: existingCharactersToSend,
        newCharacterNames: newCharacterNamesToSend,
        compiledScene,
    });

    let response = null;
    let totalFailureMessage = null;
    try {
        response = await callCombinedReconciliationLLM(prompt, profileSettings, { signal: options.signal });
    } catch (error) {
        totalFailureMessage = `Scene reconciliation failed: ${error?.message || error}`;
        errors.push(totalFailureMessage);
    }

    // 5. Distribute the response into the exact same result shape as before.
    if (hasArcToProcess) {
        if (totalFailureMessage) {
            result.arcOperation = {
                status: 'error',
                entry: arcEntryForPrompt,
                oldContent: arcEntryForPrompt.content || '',
                proposedContent: null,
                error: totalFailureMessage,
            };
        } else if (response.arc && typeof response.arc.content === 'string' && response.arc.content.trim()) {
            result.arcOperation = {
                status: 'processed',
                entry: arcEntryForPrompt,
                oldContent: arcEntryForPrompt.content || '',
                proposedContent: response.arc.content,
                error: null,
            };
            result.metadata.operationsRequiringPreview++;
        } else {
            const message = 'Arc entry reconciliation failed: response is missing or malformed "arc" section.';
            result.arcOperation = {
                status: 'error',
                entry: arcEntryForPrompt,
                oldContent: arcEntryForPrompt.content || '',
                proposedContent: null,
                error: message,
            };
            errors.push(message);
        }
    }

    for (const { name, entry } of existingCharactersToSend) {
        const oldContent = entry.content || '';
        if (totalFailureMessage) {
            result.characterOperations.push({
                characterName: name,
                status: 'error',
                entry,
                oldContent,
                proposedContent: null,
                operationType: 'update',
                error: totalFailureMessage,
            });
            continue;
        }
        const matched = findValidResponseItem(response.characters, name);
        if (matched) {
            result.characterOperations.push({
                characterName: name,
                status: 'processed',
                entry,
                oldContent,
                proposedContent: matched.content,
                operationType: 'update',
                error: null,
            });
            result.metadata.operationsRequiringPreview++;
        } else {
            const message = `Character reconciliation failed for "${name}": response is missing or malformed for this character.`;
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

    for (const name of newCharacterNamesToSend) {
        if (totalFailureMessage) {
            // No dedicated 'error' state exists in the newCharacterProposals status enum
            // (pending|created|rejected) - 'rejected' is reused here matching today's convention
            // for generation failures, so the proposal is excluded from
            // applySceneReconciliationChanges() by default.
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
            continue;
        }
        const matched = findValidResponseItem(response.newCharacters, name);
        if (matched) {
            result.newCharacterProposals.push({
                characterName: name,
                status: 'pending',
                entry: null,
                proposedContent: matched.content,
                proposedTitle: matched.title || name,
                proposedKeywords: Array.isArray(matched.keywords) ? matched.keywords : [],
                userApproved: false,
                userEdits: null,
            });
            result.metadata.operationsRequiringPreview++;
        } else {
            const message = `New character profile generation failed for "${name}": response is missing or malformed for this character.`;
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

    result.success = errors.length === 0;
    return result;
}

