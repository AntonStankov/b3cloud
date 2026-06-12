import { type DragEvent, useMemo } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import ElementNode, { type ElementNodeData } from "./ElementNode";
import { useBuilderStore } from "../../store/builderStore";
import { validateGraph } from "../../domain/validation";
import type { ElementKind } from "../../domain/elements";

export const PALETTE_DND_TYPE = "application/b3kind";

const nodeTypes: NodeTypes = { infra: ElementNode };

export default function GraphCanvas() {
  const elements = useBuilderStore((s) => s.elements);
  const edges = useBuilderStore((s) => s.edges);
  const positions = useBuilderStore((s) => s.positions);
  const selectedId = useBuilderStore((s) => s.selectedId);
  const select = useBuilderStore((s) => s.select);
  const setPosition = useBuilderStore((s) => s.setPosition);
  const addElement = useBuilderStore((s) => s.addElement);
  const { screenToFlowPosition } = useReactFlow();

  const validation = useMemo(() => validateGraph(elements), [elements]);

  const nodes: Node<ElementNodeData>[] = useMemo(
    () =>
      elements.map((element) => ({
        id: element.id,
        type: "infra",
        position: positions[element.id] ?? { x: 0, y: 0 },
        data: {
          element,
          invalid: validation.byId[element.id]
            ? !validation.byId[element.id].valid
            : false,
          selected: selectedId === element.id,
        },
      })),
    [elements, positions, selectedId, validation]
  );

  const rfEdges: Edge[] = useMemo(
    () =>
      edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        animated: true,
        style: { stroke: "rgba(29,107,88,0.5)", strokeWidth: 1.6 },
      })),
    [edges]
  );

  const onNodesChange = (changes: NodeChange[]) => {
    for (const change of changes) {
      if (change.type === "position" && change.position) {
        setPosition(change.id, change.position);
      }
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    const kind = event.dataTransfer.getData(PALETTE_DND_TYPE) as ElementKind;
    if (!kind) return;
    const position = screenToFlowPosition({
      x: event.clientX,
      y: event.clientY,
    });
    addElement(kind, position);
  };

  return (
    <ReactFlow
      nodes={nodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeClick={(_, node) => select(node.id)}
      onPaneClick={() => select(null)}
      onDrop={onDrop}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      fitView
      fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
      proOptions={{ hideAttribution: true }}
      minZoom={0.4}
      maxZoom={1.5}
    >
      <Background gap={20} size={1} color="rgba(26,36,38,0.08)" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
