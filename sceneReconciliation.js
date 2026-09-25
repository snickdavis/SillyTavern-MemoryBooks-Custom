// Copyright (C) 2024–2026 Aiko Hanasaki
// SPDX-License-Identifier: AGPL-3.0-only

import { getArcEntry, getCharacterEntry, filterCharactersForReconciliation, detectCharacterNamesInSceneText } from './addlore.js';
import { sendRawCompletionRequest } from './stmemory.js';
import { getArcReconciliationPrompt, getCharacterReconciliationPrompt, getNewCharacterEntryPrompt } from './templatesArcPrompts.js';
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
 * returning the raw response text. Shared by callReconciliationLLM() so the
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
 * Parses a single-item Scene Reconciliation JSON response ({ title, content, keywords }).
 * Self-contained local equivalent of stmemory.js's parseAIJsonResponse() extraction/repair
 * pipeline (fenced-block -> whole-text -> balanced-substring candidates, JSON.parse then
 * dirty-json repair fallback) - not reused directly because that function isn't exported from
 * stmemory.js.
 *
 * @param {string} rawText
 * @returns {{title: string, content: string, keywords: string[]}}
 * @throws {ReconciliationAIError}
 */
function parseSingleReconciliationResponse(rawText) {
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
                const isValidShape = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                    && typeof parsed.content === 'string' && parsed.content.trim();
                if (isValidShape) {
                    return {
                        title: typeof parsed.title === 'string' ? parsed.title : '',
                        content: parsed.content,
                        keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
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
 * Sends a single-item Scene Reconciliation prompt to the LLM and parses the resulting JSON
 * response. This is the single LLM-call boundary used by reconcileSceneWithLorebook() - one
 * call per lorebook entry update/creation (Arc entry, each existing character, each new
 * character), restoring the original per-item architecture.
 *
 * @param {string} prompt
 * @param {Object} profileSettings - A memory-generation profile (same shape used by stmemory.js)
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{title: string, content: string, keywords: string[]}>}
 * @throws {ReconciliationAIError}
 */
export async function callReconciliationLLM(prompt, profileSettings, options = {}) {
    const rawText = await sendReconciliationLLMRequest(prompt, profileSettings, options);
    return parseSingleReconciliationResponse(rawText);
}

/**
 * Orchestrates Scene Reconciliation against a compiled scene: Arc entry reconciliation,
 * existing character entry reconciliation, and new-character profile generation.
 *
 * Must NOT write anything to the lorebook - this only produces proposals. Writing happens
 * later via applySceneReconciliationChanges() in addlore.js, after user approval via a
 * preview UI (not part of this task).
 *
 * Makes ONE LLM call PER lorebook entry update/creation (Arc entry, each existing character,
 * each new character) - this avoids one entry's length/token needs starving every other entry's
 * response of tokens, which a single combined call could do. Per-item fault isolation: if one
 * character's (or the Arc's, or one new-character's) call fails, only that operation/proposal is
 * marked as failed and processing continues for the rest.
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

    // 1. Resolve the Arc entry (unless skipped) and make ONE LLM call for it.
    if (!options.skipArcReconciliation) {
        try {
            const { entry: arcEntry } = getArcEntry(lorebookData, lorebookData);
            if (arcEntry) {
                const oldContent = arcEntry.content || '';
                try {
                    const prompt = getArcReconciliationPrompt({ arcEntry, compiledScene });
                    const response = await callReconciliationLLM(prompt, profileSettings, { signal: options.signal });
                    result.arcOperation = {
                        status: 'processed',
                        entry: arcEntry,
                        oldContent,
                        proposedContent: response.content,
                        error: null,
                    };
                    result.metadata.operationsRequiringPreview++;
                } catch (error) {
                    const message = `Arc entry reconciliation failed: ${error?.message || error}`;
                    result.arcOperation = { status: 'error', entry: arcEntry, oldContent, proposedContent: null, error: message };
                    errors.push(message);
                }
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

    // 3. For each existing character, make ONE LLM call and continue on per-item failure.
    for (const { name, entry } of existingCharactersToSend) {
        const oldContent = entry.content || '';
        try {
            const prompt = getCharacterReconciliationPrompt({ entry, characterName: name, compiledScene });
            const response = await callReconciliationLLM(prompt, profileSettings, { signal: options.signal });
            result.characterOperations.push({
                characterName: name,
                status: 'processed',
                entry,
                oldContent,
                proposedContent: response.content,
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

    // 4. For each new character candidate, make ONE LLM call and continue on per-item failure.
    for (const name of newCharacterNamesToSend) {
        try {
            const prompt = getNewCharacterEntryPrompt({ characterName: name, compiledScene });
            const response = await callReconciliationLLM(prompt, profileSettings, { signal: options.signal });
            result.newCharacterProposals.push({
                characterName: name,
                status: 'pending',
                entry: null,
                proposedContent: response.content,
                proposedTitle: response.title || name,
                proposedKeywords: Array.isArray(response.keywords) ? response.keywords : [],
                userApproved: false,
                userEdits: null,
            });
            result.metadata.operationsRequiringPreview++;
        } catch (error) {
            const message = `New character profile generation failed for "${name}": ${error?.message || error}`;
            // No dedicated 'error' state exists in the newCharacterProposals status enum
            // (pending|created|rejected) - 'rejected' is reused here matching the original
            // convention for generation failures, so the proposal is excluded from
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
            errors.push(message);
        }
    }

    result.success = errors.length === 0;
    return result;
}

