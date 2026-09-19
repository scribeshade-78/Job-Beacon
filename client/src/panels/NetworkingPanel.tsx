import { Search } from "lucide-react";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";

/**
 * Mini-Phase 4 — Networking lookup.
 *
 * UI ONLY, by explicit scope: no backend route, no contact search, no
 * enrichment provider is called here.
 *
 * Task F turned this from a working-looking search box into an obviously
 * unavailable one. Until then the field accepted typing and the button looked
 * live, so the only signal that nothing would happen arrived as a toast AFTER
 * the candidate had already spent the effort of typing a query. The panel took
 * work and returned nothing. The warning is now permanent and sits above the
 * controls, and both the field and the button are disabled, so the panel states
 * its status before anyone interacts with it rather than after.
 *
 * THE FORM HAS NO onSubmit, deliberately. There is nothing to submit, and a
 * handler whose only job is to call preventDefault would be the same dead
 * interactivity this change exists to remove. Implicit submission cannot occur
 * either: a browser only submits implicitly from a focused text control, and
 * the only text control here is disabled and therefore cannot take focus.
 */
export function NetworkingPanel() {
  return (
    <Card>
      <CardHeader>
        <CardTitle id="networking-title">Networking</CardTitle>
      </CardHeader>
      <CardContent aria-labelledby="networking-title">
        <p
          id="networking-unavailable"
          role="note"
          className="mb-3 rounded-control border border-status-under-review/40 bg-status-under-review/8 px-3 py-2 text-xs text-status-under-review-fg"
        >
          <span className="font-semibold">Not available yet.</span>{" "}
          Contact lookup is in development — there is no search behind this panel, so the
          field below is disabled rather than accepting a query that cannot run.
        </p>

        <form className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="networking-query">Find contacts</Label>
            {/* Stacks below sm: side by side, the input was left too narrow to
                read what had been typed into it. */}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                id="networking-query"
                disabled
                aria-describedby="networking-unavailable"
                placeholder="Contact search is not available yet"
                autoComplete="off"
              />
              <Button type="submit" disabled className="shrink-0">
                <Search className="h-4 w-4" aria-hidden="true" />
                Search
              </Button>
            </div>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
