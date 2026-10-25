/**
 * World Info Selective Logic Enums
 * Aligns with frontend world_info_logic
 */
export const WI_LOGIC = Object.freeze({
    AND_ANY: 0,
    NOT_ALL: 1,
    NOT_ANY: 2,
    AND_ALL: 3,
});

/**
 * World Info Output Position Enums
 * Aligns with frontend world_info_position
 */
export const WI_POSITION = Object.freeze({
    before: 0,
    after: 1,
    ANTop: 2,
    ANBottom: 3,
    atDepth: 4,
    EMTop: 5,
    EMBottom: 6,
    outlet: 7,
});

/**
 * World Info Anchor Position Enums (e.g. for EMEntries)
 * Aligns with frontend wi_anchor_position
 */
export const WI_ANCHOR_POSITION = Object.freeze({
    before: 0,
    after: 1,
});

/**
 * Extension prompt roles
 * Aligns with frontend extension_prompt_roles
 */
export const EXTENSION_PROMPT_ROLES = Object.freeze({
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
});

export const DEFAULT_DEPTH = 4;
export const MAX_SCAN_DEPTH = 100;
