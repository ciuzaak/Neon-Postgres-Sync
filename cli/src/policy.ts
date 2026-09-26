import { candidateFor, computeDiffStats, countLines, SyncPlan } from '../../src/core/plan';
import type { SyncDirection } from '../../src/core/types';

/**
 * The CLI's safety rule (spec 2026-09-26-cli-design.md, "Safety rule for
 * applying"): which rows may be applied without an explicit per-row
 * decision. Everything that could discard a change nobody reviewed needs one.
 */
export type RowKind =
    | 'in-sync'   // identical
    | 'auto'      // direction known not to discard unreviewed changes
    | 'decide'    // needs an explicit per-row decision (prompt, or --prefer with a name)
    | 'error';    // can't sync until something is fixed

export interface RowClass {
    kind: RowKind;
    /** Suggested direction (also for 'decide' rows: the timestamp guess, if any). */
    direction?: SyncDirection;
    /** Short status label, e.g. "remote changed". */
    label: string;
    /** Why a row needs a decision or can't sync; for display. */
    detail?: string;
    added: number;
    removed: number;
}

/** A large deletion gets a human look even when the direction is known. */
export function isLargeDeletion(candidate: string, destination: string): boolean {
    if (destination.trim() === '') return false;
    if (candidate.trim() === '') return true;
    const { removed } = computeDiffStats(candidate, destination, 'upload'); // lines of destination not kept
    return removed >= 10 && removed > countLines(destination) / 2;
}

export function classify(plan: SyncPlan): RowClass {
    const none = { added: 0, removed: 0 };
    switch (plan.status) {
        case 'identical':
            return { kind: 'in-sync', label: 'in sync', ...none };
        case 'missing-both':
            return { kind: 'error', label: 'missing on both sides', ...none };
        case 'parse-error':
            return {
                kind: 'error',
                label: `${plan.parseError?.side ?? 'a side'} is not valid JSONC`,
                detail: plan.parseError?.message,
                ...none
            };
    }

    const direction = plan.suggestion.direction;
    const stats = computeDiffStats(plan.localContent, plan.remoteContent, direction);
    const decide = (label: string, detail?: string): RowClass => ({ kind: 'decide', direction, label, detail, ...stats });

    if (!plan.localExists || !plan.remoteExists) {
        const missing = plan.localExists ? 'remote' : 'local';
        if (plan.baselineExists) {
            return decide(`deleted ${missing === 'local' ? 'locally' : 'remotely'}`,
                `the ${missing} side was deleted since the last sync; restoring it may undo a deliberate deletion`);
        }
        return { kind: 'auto', direction, label: plan.localExists ? 'local only' : 'remote only', ...stats };
    }

    if (plan.change === 'both') {
        return decide('both changed', plan.suggestion.reason);
    }
    if (plan.change === 'unknown') {
        const why = plan.baselineExists ? 'excludeKeys changed' : 'no history';
        return decide(`${why} · newer ${direction === 'upload' ? 'local' : 'remote'}`, plan.suggestion.reason);
    }

    // change is 'local' or 'remote': the direction is known.
    const destination = direction === 'upload' ? plan.remoteContent : plan.localContent;
    if (isLargeDeletion(candidateFor(plan, direction), destination)) {
        return decide('large deletion', `this would remove ${stats.removed} of the destination's lines`);
    }
    return { kind: 'auto', direction, label: plan.change === 'local' ? 'local changed' : 'remote changed', ...stats };
}

/**
 * Why forcing `direction` (pull/push) needs an explicit per-row decision, or
 * undefined if it's safe to apply unattended. The safety rule applies to
 * forced directions too: overwriting a side that changed since the last sync
 * (or whose status is unknown), a large deletion in that direction, and
 * recreating a side deleted since the last sync all need a decision.
 * (A missing *source* side is refused separately, never applied.)
 */
export function forcedNeedsDecision(plan: SyncPlan, direction: SyncDirection): string | undefined {
    if (plan.status === 'identical') return undefined;
    const destinationExists = direction === 'upload' ? plan.remoteExists : plan.localExists;
    const destination = direction === 'upload' ? 'remote' : 'local';
    if (!destinationExists) {
        return plan.baselineExists
            ? `recreates the ${destination} side, which was deleted since the last sync`
            : undefined;
    }
    if (overwritesUnreviewed(plan, direction)) {
        return plan.change === 'unknown'
            ? `may overwrite unreviewed ${destination} changes (no sync history)`
            : `overwrites ${destination} changes made since the last sync`;
    }
    const target = direction === 'upload' ? plan.remoteContent : plan.localContent;
    if (isLargeDeletion(candidateFor(plan, direction), target)) {
        const { removed } = computeDiffStats(plan.localContent, plan.remoteContent, direction);
        return `large deletion: removes ${removed} of the ${destination} lines`;
    }
    return undefined;
}

/**
 * Whether forcing `direction` would overwrite a side that changed since the
 * last sync, or whose change status is unknown.
 */
export function overwritesUnreviewed(plan: SyncPlan, direction: SyncDirection): boolean {
    if (plan.status === 'identical') return false;
    const destinationExists = direction === 'upload' ? plan.remoteExists : plan.localExists;
    if (!destinationExists) return false;
    if (plan.change === 'both' || plan.change === 'unknown') return true;
    const destinationChanged = direction === 'upload' ? plan.change === 'remote' : plan.change === 'local';
    return destinationChanged;
}

/**
 * The side a direction reads from must exist, or the destination would be
 * overwritten with nothing. Deletions aren't synced: a decision whose source
 * is missing is always refused.
 */
export function sourceMissing(plan: SyncPlan, direction: SyncDirection): string | undefined {
    if (direction === 'upload' && !plan.localExists) return 'there is no local file to upload';
    if (direction === 'download' && !plan.remoteExists) return 'there is no remote record to download';
    return undefined;
}
