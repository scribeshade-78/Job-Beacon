import { Briefcase } from "lucide-react";
import { Card, CardContent } from "../components/ui/card";
import { EmptyState } from "../components/ui/empty-state";

export function OpportunitiesPage() {
  return (
    <Card>
      <CardContent>
        <EmptyState
          icon={Briefcase}
          title="Opportunities isn't built yet"
          description="There's no job-browse screen in the client yet — nothing to show here yet."
        />
      </CardContent>
    </Card>
  );
}
