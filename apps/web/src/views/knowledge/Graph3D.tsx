import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph3D, { type ForceGraphMethods } from "react-force-graph-3d";
import SpriteText from "three-spritetext";
import { Vector2 } from "three";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type { KnowledgeGraph } from "@atelier/protocol";

export interface Graph3DProps {
  graph: KnowledgeGraph;
  theme: "dark" | "light";
}

const KIND_COLORS: Record<string, string> = {
  file: "#8b9cf8",
  feature: "#fbbf24",
  lesson: "#fbbf24",
  class: "#f472b6",
  interface: "#f472b6",
  function: "#34d399",
  method: "#34d399",
  hook: "#c4b5fd",
  component: "#67e8f9",
};

const DIM = "rgba(120, 120, 140, 0.10)";
/** Synapse palette: links glow per relationship kind. */
const LINK_COLORS: Record<string, string> = {
  call: "rgba(103, 232, 249, 0.85)", // cyan signals
  import: "rgba(139, 156, 248, 0.75)", // indigo structure
  member: "rgba(196, 181, 253, 0.4)", // faint membership tethers
  ref: "rgba(148, 163, 184, 0.5)",
  feature: "rgba(251, 191, 36, 0.7)",
  lesson: "rgba(251, 191, 36, 0.7)",
};

interface GNode {
  id: string;
  label: string;
  kind: string;
  path?: string;
  x?: number;
  y?: number;
  z?: number;
}

interface GLink {
  source: string | GNode;
  target: string | GNode;
  kind: string;
}

/**
 * 3D orbit view: the code graph as a rotatable cloud. Files are the large
 * bodies; their functions cluster around them like moons (membership
 * links). Auto-rotates until you grab it; clicking a node spotlights its
 * connections and dims the rest; background click clears.
 */
export function Graph3D({ graph, theme }: Graph3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphMethods<GNode, GLink> | undefined>(undefined);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Selection is per-graph; a new graph clears the spotlight.
  useEffect(() => setSelected(null), [graph]);

  const data = useMemo(() => {
    const nodes: GNode[] = graph.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      kind: n.kind,
      path: n.path,
    }));
    const links: GLink[] = graph.edges.map((e) => ({
      source: e.source,
      target: e.target,
      kind: e.kind,
    }));
    // Membership links pull a file's functions around it like moons.
    for (const n of graph.nodes) {
      if (n.parentId) {
        links.push({ source: n.parentId, target: n.id, kind: "member" });
      }
    }
    return { nodes, links };
  }, [graph]);

  /** Neighborhood of the selected node (computed from the wire graph). */
  const spotlight = useMemo(() => {
    if (!selected) return null;
    const ids = new Set([selected]);
    for (const e of graph.edges) {
      if (e.source === selected) ids.add(e.target);
      if (e.target === selected) ids.add(e.source);
    }
    for (const n of graph.nodes) {
      if (n.parentId === selected) ids.add(n.id);
      if (n.id === selected && n.parentId) ids.add(n.parentId);
    }
    return ids;
  }, [selected, graph]);

  const linkLit = (link: GLink): boolean => {
    if (!spotlight) return true;
    const s = typeof link.source === "object" ? link.source.id : link.source;
    const t = typeof link.target === "object" ? link.target.id : link.target;
    return s === selected || t === selected;
  };

  // Auto-rotate while nothing is selected.
  useEffect(() => {
    const controls = fgRef.current?.controls() as
      | { autoRotate: boolean; autoRotateSpeed: number }
      | undefined;
    if (controls) {
      controls.autoRotate = selected === null;
      controls.autoRotateSpeed = 0.7;
    }
  }, [selected, size]);

  const dark = theme === "dark";

  // Neural glow: bloom post-processing makes nodes and signal particles
  // luminous, like synapses firing.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || size.w === 0) return;
    const bloom = new UnrealBloomPass(
      new Vector2(size.w, size.h),
      dark ? 1.6 : 0.7, // strength
      0.7, // radius
      0.05 // threshold
    );
    fg.postProcessingComposer().addPass(bloom);
    return () => {
      fg.postProcessingComposer().removePass(bloom);
    };
  }, [size.w > 0, dark]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={containerRef} className="h-full w-full">
      {size.w > 0 && (
        <ForceGraph3D<GNode, GLink>
          ref={fgRef}
          width={size.w}
          height={size.h}
          graphData={data}
          backgroundColor="rgba(0,0,0,0)"
          nodeLabel={(n) => `${n.label}${n.path ? ` — ${n.path}` : ""}`}
          nodeVal={(n) => (n.kind === "file" ? 9 : 2.5)}
          nodeColor={(n) =>
            spotlight && !spotlight.has(n.id)
              ? DIM
              : (KIND_COLORS[n.kind] ?? "#94a3b8")
          }
          nodeOpacity={0.9}
          nodeThreeObjectExtend
          nodeThreeObject={(n) => {
            // Label files always; label symbols only inside the spotlight.
            const lit = spotlight ? spotlight.has(n.id) : n.kind === "file";
            if (!lit) return false as unknown as never;
            const sprite = new SpriteText(n.label);
            sprite.color =
              spotlight && !spotlight.has(n.id)
                ? "rgba(120,120,140,0.2)"
                : dark
                  ? "#e2e8f0"
                  : "#1e293b";
            sprite.textHeight = n.kind === "file" ? 3.4 : 2.4;
            sprite.position.y = n.kind === "file" ? 8 : 5;
            return sprite;
          }}
          linkColor={(l) =>
            linkLit(l) ? (LINK_COLORS[l.kind] ?? LINK_COLORS.ref!) : DIM
          }
          linkOpacity={0.55}
          linkWidth={(l) =>
            spotlight ? (linkLit(l) ? 1.8 : 0.2) : l.kind === "member" ? 0.4 : 0.9
          }
          linkCurvature={0.18}
          linkDirectionalParticles={(l) => {
            // Signals flow constantly — the neural feel. Membership
            // tethers stay quiet; spotlight intensifies its own paths.
            if (l.kind === "member") return 0;
            if (!spotlight) return 2;
            return linkLit(l) ? 4 : 0;
          }}
          linkDirectionalParticleWidth={(l) => (linkLit(l) ? 1.9 : 0.8)}
          linkDirectionalParticleSpeed={0.0045}
          linkDirectionalParticleColor={(l) =>
            l.kind === "call" ? "#a5f3fc" : "#c7d2fe"
          }
          onNodeClick={(n) => {
            setSelected((prev) => (prev === n.id ? null : n.id));
            const dist = Math.hypot(n.x ?? 0, n.y ?? 0, n.z ?? 0) || 1;
            const ratio = 1 + 130 / dist;
            fgRef.current?.cameraPosition(
              {
                x: (n.x ?? 0) * ratio,
                y: (n.y ?? 0) * ratio,
                z: (n.z ?? 0) * ratio,
              },
              { x: n.x ?? 0, y: n.y ?? 0, z: n.z ?? 0 },
              900
            );
          }}
          onBackgroundClick={() => setSelected(null)}
        />
      )}
    </div>
  );
}
