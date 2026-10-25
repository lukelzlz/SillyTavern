import crypto from 'node:crypto';
import { getConfigValue } from '../util.js';

/**
 * Safe configuration reader that falls back gracefully when CLI args are not initialized.
 * @param {string} key
 * @param {any} defaultValue
 * @param {'boolean'|'number'|null} [typeConverter]
 * @returns {any}
 */
function getCoreConfig(key, defaultValue, typeConverter = null) {
    const envKey = 'SILLYTAVERN_' + String(key).toUpperCase().replace(/\./g, '_');
    if (envKey in process.env) {
        const val = process.env[envKey];
        if (typeConverter === 'boolean') {
            return String(val).toLowerCase() === 'true';
        }
        if (typeConverter === 'number') {
            const num = parseFloat(val);
            return isNaN(num) ? defaultValue : num;
        }
        return val;
    }
    if (!globalThis.COMMAND_LINE_ARGS) {
        return defaultValue;
    }
    return getConfigValue(key, defaultValue, typeConverter);
}

/**
 * @typedef {object} TicketRecord
 * @property {string} userHandle
 * @property {string} [accountVersion]
 * @property {string} [ip]
 * @property {number} createdAt
 * @property {number} expiresAt
 */

export class TicketManager {
    constructor() {
        /** @type {Map<string, TicketRecord>} token -> record */
        this.tickets = new Map();
        /** @type {Map<string, Set<string>>} userHandle -> Set of tokens */
        this.userTickets = new Map();

        // Background sweeper to prune expired tickets
        this.cleanupInterval = setInterval(() => {
            this.purgeExpired();
        }, 5000);
        if (this.cleanupInterval && typeof this.cleanupInterval.unref === 'function') {
            this.cleanupInterval.unref();
        }
    }

    get ttlSeconds() {
        return getCoreConfig('core.transport.ticketTtlSeconds', 30, 'number');
    }

    get maxPendingTickets() {
        return getCoreConfig('core.transport.maxPendingTickets', 1000, 'number');
    }

    /**
     * Issues a short-lived single-use ticket for an authenticated user.
     * @param {{ userHandle: string, accountVersion?: string, ip?: string }} params
     * @returns {{ ticket: string, expiresIn: number }}
     */
    issueTicket({ userHandle, accountVersion, ip }) {
        if (!userHandle || typeof userHandle !== 'string') {
            throw new Error('userHandle is required to issue a ticket');
        }

        // Capacity guard: sweep expired first if near threshold
        if (this.tickets.size >= this.maxPendingTickets) {
            this.purgeExpired();
            if (this.tickets.size >= this.maxPendingTickets) {
                throw new Error('Ticket capacity limit exceeded; retry later');
            }
        }

        // 256-bit cryptographically secure random token
        const token = crypto.randomBytes(32).toString('base64url');
        const now = Date.now();
        const ttlSec = Math.max(1, this.ttlSeconds);
        const expiresAt = now + ttlSec * 1000;

        const record = {
            userHandle,
            accountVersion,
            ip,
            createdAt: now,
            expiresAt,
        };

        this.tickets.set(token, record);

        let userSet = this.userTickets.get(userHandle);
        if (!userSet) {
            userSet = new Set();
            this.userTickets.set(userHandle, userSet);
        }
        userSet.add(token);

        return {
            ticket: token,
            expiresIn: ttlSec,
        };
    }

    /**
     * Atomically consumes a ticket.
     * If valid, deletes immediately and returns user context.
     * If invalid, expired, or replayed, returns null.
     * @param {string} token
     * @returns {{ userHandle: string, accountVersion?: string, ip?: string } | null}
     */
    consumeTicket(token) {
        if (!token || typeof token !== 'string') {
            return null;
        }

        const record = this.tickets.get(token);
        if (!record) {
            return null;
        }

        // Single-use: atomically delete immediately so replay attempts fail
        this.tickets.delete(token);

        const userSet = this.userTickets.get(record.userHandle);
        if (userSet) {
            userSet.delete(token);
            if (userSet.size === 0) {
                this.userTickets.delete(record.userHandle);
            }
        }

        // Expiration check
        if (Date.now() > record.expiresAt) {
            return null;
        }

        return {
            userHandle: record.userHandle,
            accountVersion: record.accountVersion,
            ip: record.ip,
        };
    }

    /**
     * Revokes all pending tickets for a given user handle.
     * @param {string} userHandle
     */
    revokeUserTickets(userHandle) {
        if (!userHandle) return;
        const userSet = this.userTickets.get(userHandle);
        if (userSet) {
            for (const token of userSet) {
                this.tickets.delete(token);
            }
            this.userTickets.delete(userHandle);
        }
    }

    /**
     * Prunes expired tickets from memory.
     */
    purgeExpired() {
        const now = Date.now();
        for (const [token, record] of this.tickets.entries()) {
            if (now > record.expiresAt) {
                this.tickets.delete(token);
                const userSet = this.userTickets.get(record.userHandle);
                if (userSet) {
                    userSet.delete(token);
                    if (userSet.size === 0) {
                        this.userTickets.delete(record.userHandle);
                    }
                }
            }
        }
    }

    /**
     * Clears all tickets (primarily for testing).
     */
    clear() {
        this.tickets.clear();
        this.userTickets.clear();
    }

    /**
     * Stops the background sweeper and clears tickets.
     */
    destroy() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.clear();
    }
}

export const ticketManager = new TicketManager();
export default ticketManager;
