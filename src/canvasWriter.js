import crypto from "node:crypto";

// Obsidian Canvas（.canvas）檔案格式：JSON Canvas 1.0（https://jsoncanvas.org）。
//   nodes: { id, type: "text"|"file"|"link"|"group", x, y, width, height, text|file|url|label, color? }
//   edges: { id, fromNode, toNode, fromSide?, toSide?, label?, color? }
// 座標是節點左上角；Obsidian 不會自動排版，位置由 canvasLayout.js 算好再放進來。
// color 用 Obsidian 預設色號 "1"~"6"（紅、橘、黃、綠、青、紫）。Canvas 不支援線條粗細，關係種類用顏色區分。

const newId = () => crypto.randomBytes(8).toString("hex");

/** @param {{nodes?: object[], edges?: object[]}} [initial] 既有的 canvas 內容（增量更新時從檔案讀進來），原樣保留 */
export function createCanvas(initial = {}) {
  const nodes = [...(initial.nodes || [])];
  const edges = [...(initial.edges || [])];
  const ids = new Set(nodes.map((n) => n.id));

  function addNode(node) {
    const id = newId();
    ids.add(id);
    nodes.push({ id, ...node, x: Math.round(node.x), y: Math.round(node.y), width: Math.round(node.width), height: Math.round(node.height) });
    return id;
  }

  return {
    /** Markdown 文字卡 */
    addText: ({ text, color, ...box }) => addNode({ type: "text", text, ...box, ...(color ? { color } : {}) }),
    /** 指向 vault 內檔案的卡片（Obsidian 會顯示預覽、可點進去） */
    addFile: ({ file, color, ...box }) => addNode({ type: "file", file, ...box, ...(color ? { color } : {}) }),
    /** 網址卡（Obsidian 會顯示網頁預覽） */
    addLink: ({ url, color, ...box }) => addNode({ type: "link", url, ...box, ...(color ? { color } : {}) }),
    /** 群組框（畫在其他卡片後面當背景） */
    addGroup: ({ label, color, ...box }) => addNode({ type: "group", label, ...box, ...(color ? { color } : {}) }),
    /** 連線；from / to 是 add* 回傳的 id */
    addEdge({ from, to, label, color, fromSide, toSide }) {
      if (!ids.has(from) || !ids.has(to)) throw new Error("連線的節點不存在");
      const edge = { id: newId(), fromNode: from, toNode: to };
      if (fromSide) edge.fromSide = fromSide;
      if (toSide) edge.toSide = toSide;
      if (label) edge.label = label;
      if (color) edge.color = color;
      edges.push(edge);
      return edge.id;
    },
    get nodeCount() {
      return nodes.length;
    },
    toJSON: () => ({ nodes: [...nodes], edges: [...edges] }),
  };
}

// 文字卡高度估算：Obsidian 不會自動撐高卡片，太矮會出現捲軸。中英混排粗估每行約 18 個字。
export function textCardSize(text, width = 360) {
  const charsPerLine = Math.max(10, Math.floor(width / 20));
  const lines = String(text)
    .split("\n")
    .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
  return { width, height: Math.min(900, 40 + lines * 26) };
}
