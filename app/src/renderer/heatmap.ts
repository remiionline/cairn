import { isoDate, parseIso } from "../shared/model";
import { div, span } from "./dom";

export interface HeatmapOptions {
  /** Completed-task count per YYYY-MM-DD. */
  counts: Map<string, number>;
  selected?: string | null;
  onSelect?: (date: string) => void;
  weeks?: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function level(n: number): number {
  if (n <= 0) return 0;
  if (n === 1) return 1;
  if (n <= 3) return 2;
  if (n <= 5) return 3;
  return 4;
}

export function formatDay(iso: string): string {
  return parseIso(iso).toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
}

/** GitHub-style contribution grid: one column per week, Sunday at the top. */
export function renderHeatmap(parent: HTMLElement, opts: HeatmapOptions): HTMLElement {
  const weeks = opts.weeks ?? 53;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const todayIso = isoDate(now);
  const start = new Date(now);
  start.setDate(start.getDate() - start.getDay() - (weeks - 1) * 7);

  const wrap = div(parent, "heatmap ticks");
  const scroller = div(wrap, "heatmap-scroll");
  const inner = div(scroller, "heatmap-inner");
  const days = div(inner, "heatmap-days");
  ["", "Mon", "", "Wed", "", "Fri", ""].forEach((d) => div(days, "", d));
  const right = div(inner);
  const months = div(right, "heatmap-months");
  const grid = div(right, "heatmap-grid");

  let total = 0;
  let lastMonth = -1;
  const d = new Date(start);
  for (let w = 0; w < weeks; w++) {
    if (d.getMonth() !== lastMonth && w < weeks - 2) {
      lastMonth = d.getMonth();
      span(months, "", MONTHS[lastMonth]).style.gridColumn = `${w + 1} / span 4`;
    }
    for (let dow = 0; dow < 7; dow++) {
      const iso = isoDate(d);
      const cell = div(grid, "cell");
      if (iso > todayIso) {
        cell.classList.add("future");
      } else {
        const n = opts.counts.get(iso) ?? 0;
        total += n;
        cell.classList.add(`l${level(n)}`);
        cell.title = `${n === 0 ? "No" : n} task${n === 1 ? "" : "s"} completed · ${formatDay(iso)}`;
        if (iso === opts.selected) cell.classList.add("selected");
        if (iso === todayIso) cell.classList.add("today");
        if (opts.onSelect) {
          cell.classList.add("clickable");
          cell.addEventListener("click", () => opts.onSelect!(iso));
        }
      }
      d.setDate(d.getDate() + 1);
    }
  }

  const footer = div(wrap, "heatmap-footer");
  span(footer, "", `${total} task${total === 1 ? "" : "s"} completed in the last year`);
  const legend = div(footer, "heatmap-legend");
  span(legend, "", "Less");
  for (let l = 0; l <= 4; l++) div(legend, `cell l${l}`);
  span(legend, "", "More");

  // Keep the most recent weeks in view: on first layout, and whenever the
  // panel is resized, unless the user has scrolled back to look at history.
  let pinned = true;
  const pin = () => { if (pinned) scroller.scrollLeft = scroller.scrollWidth; };
  scroller.addEventListener("scroll", () => {
    pinned = scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 4;
  }, { passive: true });
  new ResizeObserver(pin).observe(scroller);
  requestAnimationFrame(pin);
  return wrap;
}
