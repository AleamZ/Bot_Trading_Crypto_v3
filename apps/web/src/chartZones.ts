import type { IChartApiBase, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, Logical, SeriesAttachedParameter, SeriesType, Time } from "lightweight-charts";

/** A shaded box (or a dashed level when `line`) drawn behind the candles. */
export interface Zone {
  /** Bar indexes, inclusive; `to` may go past the last candle (the space on the right). */
  from: number;
  to: number;
  top: number;
  bottom: number;
  color: string;
  /** Fill opacity, 0 to 1. */
  alpha: number;
  outline?: boolean;
  /** Draw a dashed horizontal line at `top` instead of a box. */
  line?: boolean;
  label?: string;
}

type Target = Parameters<IPrimitivePaneRenderer["draw"]>[0];

/**
 * Boxes lightweight-charts has no series for: fair value gaps, and the take profit (green) / stop
 * loss (red) zones of the bot's trades and of the entry it would make now. Drawn under the candles.
 */
export class ZonesPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private readonly views: readonly IPrimitivePaneView[];

  constructor(
    private readonly zones: readonly Zone[],
    private readonly textColor: string,
  ) {
    const renderer: IPrimitivePaneRenderer = { draw: (target) => this.draw(target) };
    this.views = [{ zOrder: () => "bottom", renderer: () => renderer }];
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart;
    this.series = param.series;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  private draw(target: Target): void {
    const { chart, series } = this;
    if (!chart || !series) return;
    const time = chart.timeScale();
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      for (const z of this.zones) {
        // Bar centres are at whole indexes (logicalToCoordinate is wrong for fractions): widen by
        // half a bar each side so a box covers its first and last bar fully.
        const xa = time.logicalToCoordinate(z.from as Logical);
        const xb = time.logicalToCoordinate(z.to as Logical);
        const next = time.logicalToCoordinate((z.from + 1) as Logical);
        const y1 = series.priceToCoordinate(z.top);
        const y2 = series.priceToCoordinate(z.bottom);
        if (xa === null || xb === null || next === null || y1 === null || y2 === null) continue;
        const half = Math.abs(next - xa) / 2;
        const left = Math.round((Math.min(xa, xb) - half) * hr);
        const width = Math.max(1, Math.round((Math.abs(xb - xa) + 2 * half) * hr));
        const top = Math.round(Math.min(y1, y2) * vr);
        const height = Math.max(1, Math.round(Math.abs(y2 - y1) * vr));
        if (z.line) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = z.color;
          ctx.lineWidth = Math.max(1, Math.round(2 * vr));
          ctx.setLineDash([Math.round(6 * hr), Math.round(4 * hr)]);
          ctx.beginPath();
          ctx.moveTo(left, Math.round(y1 * vr));
          ctx.lineTo(left + width, Math.round(y1 * vr));
          ctx.stroke();
          ctx.setLineDash([]);
        } else {
          ctx.globalAlpha = z.alpha;
          ctx.fillStyle = z.color;
          ctx.fillRect(left, top, width, height);
          if (z.outline) {
            ctx.globalAlpha = 1;
            ctx.strokeStyle = z.color;
            ctx.lineWidth = Math.max(1, Math.round(hr));
            ctx.strokeRect(left + 0.5, top + 0.5, width - 1, height - 1);
          }
        }
        if (z.label) {
          ctx.globalAlpha = 1;
          ctx.fillStyle = z.line ? z.color : this.textColor;
          ctx.font = `700 ${Math.round(10 * vr)}px "IBM Plex Mono", ui-monospace, monospace`;
          ctx.textBaseline = "top";
          ctx.fillText(z.label, left + Math.round(4 * hr), (z.line ? Math.round(y1 * vr) : top) + Math.round(3 * vr));
        }
      }
      ctx.globalAlpha = 1;
    });
  }
}
