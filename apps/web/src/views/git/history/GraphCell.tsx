import { memo } from "react";
import type { GraphRow, GraphSegment } from "@/lib/commit-graph";
import { laneColor } from "@/lib/commit-graph";
import { initials } from "./format";

export const ROW_H = 30;
export const LANE_W = 16;
const PAD = 10;

const x = (col: number) => PAD + col * LANE_W;

/** A lane line through half a row, bent with a curve when it changes lane. */
function segmentPath(seg: GraphSegment, half: "top" | "bottom"): string {
  const y0 = half === "top" ? 0 : ROW_H / 2;
  const y1 = half === "top" ? ROW_H / 2 : ROW_H;
  const x0 = x(seg.from);
  const x1 = x(seg.to);
  if (x0 === x1) return `M${x0} ${y0}L${x1} ${y1}`;
  const mid = (y0 + y1) / 2;
  return `M${x0} ${y0}C${x0} ${mid} ${x1} ${mid} ${x1} ${y1}`;
}

/**
 * One row of the commit graph. Lines are drawn in two halves so each row
 * is self-contained — stacked, the halves join into continuous lanes.
 * The node is the author's avatar in the lane's colour, as in GitKraken;
 * a merge is a small solid dot, since it records no work of its own.
 */
export const GraphCell = memo(function GraphCell(props: {
  row: GraphRow;
  width: number;
  author: string;
  head: boolean;
}) {
  const { row } = props;
  const w = PAD * 2 + (props.width - 1) * LANE_W;
  const cx = x(row.col);
  const cy = ROW_H / 2;
  const color = laneColor(row.color);

  return (
    <svg
      width={w}
      height={ROW_H}
      className="block shrink-0 overflow-visible"
      aria-hidden
    >
      {row.top.map((s, i) => (
        <path
          key={`t${i}`}
          d={segmentPath(s, "top")}
          stroke={laneColor(s.color)}
          strokeWidth={2}
          fill="none"
        />
      ))}
      {row.bottom.map((s, i) => (
        <path
          key={`b${i}`}
          d={segmentPath(s, "bottom")}
          stroke={laneColor(s.color)}
          strokeWidth={2}
          fill="none"
        />
      ))}
      {row.merge ? (
        <circle cx={cx} cy={cy} r={4} fill={color} />
      ) : (
        <g>
          {props.head && (
            <circle
              cx={cx}
              cy={cy}
              r={10.5}
              fill="none"
              stroke={color}
              strokeOpacity={0.45}
              strokeWidth={2}
            />
          )}
          <circle
            cx={cx}
            cy={cy}
            r={8}
            fill="var(--card)"
            stroke={color}
            strokeWidth={2}
          />
          <text
            x={cx}
            y={cy}
            dy="0.35em"
            textAnchor="middle"
            fontSize={7}
            fontWeight={700}
            fill={color}
          >
            {initials(props.author)}
          </text>
        </g>
      )}
    </svg>
  );
});
