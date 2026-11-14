import { useId } from "react";
import { sessionTimeline, viewerTimeZone, type TimelineSpan } from "./session-timeline";

const WIDTH = 1000;

function SessionBar({ span, x, clipId }: { span: TimelineSpan; x: (min: number) => number; clipId: string }) {
  const left = x(span.startMin);
  const width = Math.max(1.5, x(span.endMin) - left);
  const label = `${span.label} ${span.startLabel}–${span.endLabel}${span.current ? ", current session" : ""}`;
  return (
    <g>
      <title>{label}</title>
      <rect
        className={`session-bar ${span.id}${span.current ? " is-current" : ""}`}
        x={left}
        y={8}
        width={width}
        height={52}
        rx={8}
      />
      {width > 52 && (
        <text className="bar-label" x={left + 8} y={28} clipPath={`url(#${clipId})`}>{span.label}</text>
      )}
      {width > 96 && (
        <text className="bar-time" x={left + 8} y={46} clipPath={`url(#${clipId})`}>{span.startLabel}–{span.endLabel}</text>
      )}
    </g>
  );
}

export function SessionChart({ now = new Date(), timeZone }: { now?: Date; timeZone?: string }) {
  const zone = timeZone || viewerTimeZone();
  const model = sessionTimeline(now, zone);
  const reactId = useId().replace(/:/g, "");
  const x = (min: number) => (min / model.dayMinutes) * WIDTH;
  const nowX = x(model.nowMin);
  const nowAnchor = model.nowMin < model.dayMinutes * 0.08 ? "start" : model.nowMin > model.dayMinutes * 0.92 ? "end" : "middle";
  return (
    <figure className="session-chart" aria-label={`US equity sessions in ${model.timeZoneName}`}>
      <figcaption className="session-caption">US equity sessions · {model.timeZoneName}</figcaption>
      <svg viewBox={`0 0 ${WIDTH} 108`} role="img" aria-labelledby={`${reactId}-title`}>
        <title id={`${reactId}-title`}>Market sessions for this local day, times in {model.timeZoneName}</title>
        <defs>
          {model.spans.map((span, index) => {
            const left = x(span.startMin);
            const width = Math.max(1.5, x(span.endMin) - left);
            return (
              <clipPath id={`${reactId}-clip-${index}`} key={`${span.id}-${index}`}>
                <rect x={left + 6} y={8} width={Math.max(0, width - 12)} height={52} />
              </clipPath>
            );
          })}
        </defs>
        {model.spans.map((span, index) => (
          <SessionBar key={`${span.id}-${span.startMin}-${index}`} span={span} x={x} clipId={`${reactId}-clip-${index}`} />
        ))}
        <line className="session-now" x1={nowX} x2={nowX} y1={2} y2={64} />
        <text className="now-label" x={nowX} y={78} textAnchor={nowAnchor}>Now</text>
        {model.ticks.map((tick) => (
          <g key={tick.label + tick.min}>
            <line className="tick" x1={x(tick.min)} x2={x(tick.min)} y1={64} y2={72} />
            <text className="session-axis" x={x(tick.min)} y={88} textAnchor={tick.min < 20 ? "start" : tick.min > model.dayMinutes - 20 ? "end" : "middle"}>{tick.label}</text>
          </g>
        ))}
      </svg>
      <p className="hint session-note">Stops are app-watched every 5 minutes. That is not a resting broker stop.</p>
    </figure>
  );
}
