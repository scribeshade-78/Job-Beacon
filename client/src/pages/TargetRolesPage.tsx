import { Target } from "lucide-react";
import { Card, CardContent } from "../components/ui/card";
import { EmptyState } from "../components/ui/empty-state";

export function TargetRolesPage() {
  return (
    <Card>
      <CardContent>
        <EmptyState
          icon={Target}
          title="Target roles isn't built yet"
          description="Role suggestions and selection are planned but not implemented — nothing to show here yet."
        />
      </CardContent>
    </Card>
  );
}
