'use strict';

/**
 * Shared comparator for user-orderable entities (workspaces, contexts).
 * Explicit numeric `order` sorts first (ascending), unordered entries last,
 * with a stable tiebreak on createdAt then name — the same contract the web
 * UI uses, applied at the source so every list endpoint returns the same
 * ordering (Link To pickers, CLI, sidebars, ...).
 *
 * @param {{order?: number|null, createdAt?: string, name?: string|null}} a
 * @param {{order?: number|null, createdAt?: string, name?: string|null}} b
 * @returns {number}
 */
export function compareByUserOrder(a, b) {
    const ao = Number.isFinite(a?.order) ? a.order : Number.MAX_SAFE_INTEGER;
    const bo = Number.isFinite(b?.order) ? b.order : Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    const ac = a?.createdAt ?? '';
    const bc = b?.createdAt ?? '';
    if (ac !== bc) return ac < bc ? -1 : 1;
    return String(a?.name ?? '').localeCompare(String(b?.name ?? ''));
}

export default compareByUserOrder;
