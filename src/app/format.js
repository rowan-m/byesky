// Pure display formatting helpers. No DOM access, so they can be unit tested in Node.

export function formatCount(n) {
  return typeof n === 'number' ? n.toLocaleString() : '—';
}

export function formatRelativeDate(dateStr) {
  if (!dateStr) return 'Never';
  const timestamp = new Date(dateStr).getTime();
  const diffMs = Date.now() - timestamp;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays <= 0) {
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    if (diffHours <= 0) return 'Just now';
    return `${diffHours}h ago`;
  }
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 30) return `${diffDays}d ago`;

  const date = new Date(dateStr);
  return date.toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: 'numeric' });
}

export function formatLastSynced(timestamp) {
  if (!timestamp) return 'Never synced';
  const date = new Date(timestamp);
  return (
    'Last synced: ' +
    date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  );
}

export function formatMutualsCount(criteria) {
  const count = criteria?.mutualsCount || 0;
  const isTenPlus = count > 10 || (count === 10 && criteria?.hasMoreMutuals !== false);
  return isTenPlus ? '10+' : `${count}`;
}
