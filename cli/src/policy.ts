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
 * Whether forcing `direction` would overwrite a side that changed since the
 * last sync, or whose change status is unknown — a destructive override that
 * needs a per-row confirmation (or `--force` non-interactively).
 */
export function overwritesUnreviewed(plan: SyncPlan, direction: SyncDirection): boolean {
    if (plan.status === 'identical') return false;
    const destinationExists = direction === 'upload' ? plan.remoteExists : plan.localExists;
    if (!destinationExists) return false;
    if (plan.change === 'both' || plan.change === 'unknown') return true;
    const destinationChanged = direction === 'upload' ? plan.change === 'remote' : plan.change === 'local';
    return destinationChanged;
}
