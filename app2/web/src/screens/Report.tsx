import { data } from '../data/client';
import { useAsync } from '../ui/useAsync';

export function Report() {
  const w = useAsync(() => data().week());
  const d = w.data;
  return (
    <section aria-labelledby="h-rep2">
      <header className="hd"><h1 id="h-rep2">Report</h1></header>
      {d && (
        <div className="grid" data-testid="report">
          <div className="stat lead"><b>{d.meetingsAri}<small>/{d.meetingsGoal}</small></b><span>Meetings from Ari this week</span></div>
          <div className="stat"><b>{d.replies}</b><span>Replies</span></div>
          <div className="stat"><b>{d.accepts}</b><span>Accepts</span></div>
          <div className="stat"><b>{d.connects}</b><span>Connects</span></div>
          <div className="stat"><b>{d.acceptToDm1MedianHours == null ? '–' : `${d.acceptToDm1MedianHours.toFixed(1)} h`}</b><span>Accept to DM1 (goal under 4 h)</span></div>
        </div>
      )}
    </section>
  );
}
