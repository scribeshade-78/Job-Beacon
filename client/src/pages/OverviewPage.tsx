import { SetupChecklist } from "../components/SetupChecklist";
import { AutomationPanel } from "../panels/AutomationPanel";
import { ActionRequiredPanel } from "../panels/ActionRequiredPanel";
import { TodayPanel } from "../panels/TodayPanel";

/**
 * THERE IS NO "AT A GLANCE" CARD ANY MORE, ON PURPOSE.
 *
 * It rendered four literal em-dashes — Applications submitted, Awaiting response,
 * Interviews scheduled, Tasks — from a STATS array with no data binding at all.
 * It was not a loading state and never became one: with a real application sitting
 * in 'succeeded' (Applications reads "Applied 1"), Home still showed "—", so the
 * card made a claim about the candidate's search that was permanently false.
 *
 * Two of its four figures were also duplicated by live panels further down the
 * same page: "Tasks" by ActionRequiredPanel, and the application counts by the
 * Applications page. Removing it therefore costs no information, and the grid
 * reflows on its own — AutomationPanel (4) now sits beside TodayPanel (8), with
 * ActionRequiredPanel (4) beneath them.
 *
 * When there is a real source to count, bring these numbers back ONLY as a bound
 * read of data that exists. A placeholder that looks like a statistic is worse
 * than no card.
 */

interface OverviewPageProps {
  candidateId: string | undefined;
  ready: boolean;
}

export function OverviewPage({ candidateId, ready }: OverviewPageProps) {
  return (
    <div className="space-y-6">
      {/* Full width, above the grid, and NOT gated by `ready`: the checklist must
          show its skeleton while identity is still loading. */}
      <SetupChecklist />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="lg:col-span-4">{ready && candidateId && <AutomationPanel candidateId={candidateId} />}</div>

        <div className="lg:col-span-8">{ready && <TodayPanel />}</div>

        <div className="lg:col-span-4">{ready && <ActionRequiredPanel />}</div>
      </div>
    </div>
  );
}
