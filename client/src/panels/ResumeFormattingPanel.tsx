import { useState } from "react";
import { ChevronDown, Minus, Plus } from "lucide-react";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Label } from "../components/ui/label";
import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group";
import { Switch } from "../components/ui/switch";
import { showToast } from "../components/ui/use-toast";
import { cn } from "../lib/utils";

/**
 * Mini-Phase 5 — Dynamic resume formatting toolbar.
 *
 * UI ONLY, by explicit scope: nothing here renders a document. There is no PDF
 * engine, no pagination, and no mutation of the stored resume — every control
 * writes to local useState and nothing else reads it. The Resumes page has no
 * preview surface yet, so the card says plainly that these settings are not
 * applied to anything rather than implying a rendered result the user should be
 * seeing somewhere.
 *
 * "Fit to one page" is the one control with a visible effect, and it is the
 * honest one: it reports that the pagination engine does not exist yet.
 */

const FONT_FAMILIES = ["Standard", "Arial", "Georgia"] as const;

type FontFamily = (typeof FONT_FAMILIES)[number];

const ALIGNMENTS = [
  { value: "left", label: "Left" },
  { value: "justified", label: "Justified" },
] as const;

type Alignment = (typeof ALIGNMENTS)[number]["value"];

/**
 * 0.5pt steps around a 10.5pt default, the value the brief names. Bounds are
 * enforced here rather than only by disabling the buttons, so no caller can
 * step the size out of range.
 */
const MIN_FONT_SIZE_PT = 8;
const MAX_FONT_SIZE_PT = 14;
const FONT_SIZE_STEP_PT = 0.5;
const DEFAULT_FONT_SIZE_PT = 10.5;

function clampFontSize(size: number): number {
  return Math.min(MAX_FONT_SIZE_PT, Math.max(MIN_FONT_SIZE_PT, size));
}

function formatFontSize(size: number): string {
  return size.toFixed(1) + "pt";
}

export function ResumeFormattingPanel() {
  const [fontFamily, setFontFamily] = useState<FontFamily>("Standard");
  const [fontSizePt, setFontSizePt] = useState(DEFAULT_FONT_SIZE_PT);
  const [alignment, setAlignment] = useState<Alignment>("left");
  const [fitToOnePage, setFitToOnePage] = useState(false);

  function handleFitToOnePageChange(checked: boolean) {
    setFitToOnePage(checked);
    showToast({ title: "Dynamic pagination engine is in development.", tone: "default" });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle id="resume-formatting-title">Resume Formatting</CardTitle>
      </CardHeader>
      <CardContent aria-labelledby="resume-formatting-title" className="space-y-3">
        <p className="text-xs text-ios-text-secondary">
          Choose how your generated resume is laid out. These settings are not applied to anything yet.
        </p>

        {/* One wrapping row so the toolbar stays compact and does not push the
            rest of the page below the fold. */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <div className="flex items-center gap-2">
            <Label htmlFor="resume-font-family">Font</Label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  id="resume-font-family"
                  className="inline-flex h-9 items-center gap-1.5 rounded-control border border-ios-separator bg-ios-card px-3 text-sm font-medium text-black hover:bg-ios-bg"
                >
                  {fontFamily}
                  <ChevronDown className="h-4 w-4 text-ios-text-secondary" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {FONT_FAMILIES.map((family) => (
                  <DropdownMenuItem
                    key={family}
                    onSelect={() => setFontFamily(family)}
                    className={cn(family === fontFamily && "font-semibold")}
                  >
                    {family}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="flex items-center gap-2">
            <span id="resume-font-size-label" className="text-sm font-medium text-black">
              Size
            </span>
            <div role="group" aria-labelledby="resume-font-size-label" className="flex items-center gap-1">
              <Button
                variant="secondary"
                size="icon"
                className="h-9 w-9"
                aria-label="Decrease font size"
                disabled={fontSizePt <= MIN_FONT_SIZE_PT}
                onClick={() => setFontSizePt((current) => clampFontSize(current - FONT_SIZE_STEP_PT))}
              >
                <Minus className="h-4 w-4" aria-hidden="true" />
              </Button>
              {/* aria-live so a keyboard user hears the new value without
                  having to move focus off the button they just pressed. */}
              <output
                aria-live="polite"
                className="min-w-[3.5rem] text-center text-sm font-medium tabular-nums text-black"
              >
                {formatFontSize(fontSizePt)}
              </output>
              <Button
                variant="secondary"
                size="icon"
                className="h-9 w-9"
                aria-label="Increase font size"
                disabled={fontSizePt >= MAX_FONT_SIZE_PT}
                onClick={() => setFontSizePt((current) => clampFontSize(current + FONT_SIZE_STEP_PT))}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span id="resume-alignment-label" className="text-sm font-medium text-black">
              Alignment
            </span>
            <RadioGroup
              aria-labelledby="resume-alignment-label"
              value={alignment}
              onValueChange={(value) => setAlignment(value as Alignment)}
              className="flex items-center gap-4"
            >
              {ALIGNMENTS.map((option) => (
                <div key={option.value} className="flex items-center gap-2">
                  <RadioGroupItem value={option.value} id={"resume-alignment-" + option.value} />
                  <Label htmlFor={"resume-alignment-" + option.value} className="font-normal">
                    {option.label}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </div>

          <div className="flex items-center gap-2">
            <Switch
              id="resume-fit-one-page"
              checked={fitToOnePage}
              onCheckedChange={handleFitToOnePageChange}
            />
            <Label htmlFor="resume-fit-one-page">Fit to one page</Label>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
