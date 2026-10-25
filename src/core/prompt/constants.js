export const INJECTION_POSITION = Object.freeze({
    RELATIVE: 'relative',
    ABSOLUTE: 'absolute',
});

export const ROLE_PRIORITY = Object.freeze(['system', 'user', 'assistant']);

export const EXCLUDE_SQUASH_WHITELIST = Object.freeze([
    'newMainChat',
    'newChat',
    'groupNudge',
]);

export const EXTENSION_PROMPT_ROLES = Object.freeze({
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
});

export const EXTENSION_PROMPT_TYPES = Object.freeze({
    IN_PROMPT: 0,
    BEFORE_PROMPT: 1,
    IN_CHAT: 2,
});

export const PIPELINE_STAGES = Object.freeze({
    BUDGET_INITIALIZATION: 'budget_initialization',
    BASE_PROMPTS_PRE_FORMATTING: 'base_prompts_pre_formatting',
    PRIMING_CONTROL_RESERVATION: 'priming_control_reservation',
    RELATIVE_SYSTEM_TOPOLOGY_PLACEMENT: 'relative_system_topology_placement',
    TOOL_SCHEMA_RESERVATION: 'tool_schema_reservation',
    CONTINUE_PREFILL_NUDGE_HANDLING: 'continue_prefill_nudge_handling',
    ABSOLUTE_DEPTH_LAYERED_INJECTION: 'absolute_depth_layered_injection',
    REVERSE_SLIDING_WINDOW_TRUNCATION: 'reverse_sliding_window_truncation',
    SQUASHED_SYSTEM_MESSAGES: 'squashed_system_messages',
    PLUGIN_READY_HOOK_TRANSFORMATION: 'plugin_ready_hook_transformation',
});
