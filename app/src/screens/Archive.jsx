import { Appbar } from '../components/chrome.jsx';
import { EmptyState } from '../components/ui.jsx';
import { LibraryCard } from '../components/cards.jsx';

const YEARS = [2025, 2024];

// Completed works the user read in 2024-25, taken from AO3 reading history.
// History is stored metadata-only, so these open to a Detail page where the
// user can Save the ones they want downloaded for offline reading. AO3 doesn't
// expose which history works got kudos, so there's no kudos filter.
function readingYear(work) {
  if (!work.historyReadAt) return null;
  const y = new Date(work.historyReadAt).getFullYear();
  return Number.isFinite(y) ? y : null;
}

export function ArchiveScreen({ works, nav }) {
  const open = (w) => nav.push('detail', { work: w });
  const all = (works || []).filter(
    w => w.inHistory && w.status === 'complete' && YEARS.includes(readingYear(w))
  );
  const byYear = YEARS
    .map(y => ({ year: y, items: all.filter(w => readingYear(w) === y) }))
    .filter(g => g.items.length);

  return (
    <div className="screen">
      <Appbar large title="Read in 2024–25" sub="Completed works from your history" back={() => nav.pop()} />
      <div className="scroll">
        {all.length === 0 ? (
          <div style={{ display: 'flex' }}>
            <EmptyState icon="solar:history-linear" title="Nothing here yet"
              desc="Completed works you read on AO3 in 2024–25 will appear here as your reading history syncs. Open one to save it for offline reading." />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 22, padding: '0 20px 24px' }}>
            {byYear.map(g => (
              <div key={g.year}>
                <div className="section-label" style={{ marginBottom: 12 }}>{g.year} · {g.items.length}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
                  {g.items.map(w => <LibraryCard key={w.id} work={w} onOpen={open} />)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
