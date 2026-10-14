import { createCanvas } from "./canvasWriter.js";
import { clusterLayout } from "./canvasLayout.js";

// 關聯圖增量更新：既有 canvas 是使用者可能動過的版本，以它為準只做最小改動——
//   - 節點座標、使用者自己加的卡片與連線一律不動
//   - 檔案節點：筆記搬家就改指向新路徑；筆記刪了就移除節點和連到它的線
//   - 新出現的相關筆記放進圖右邊的「新增」群組框，只補「碰到新筆記」的連線
//     （舊節點之間的線使用者可能刻意刪過，不再加回來）

export const NEW_GROUP = "新增";
const NEW_GROUP_GAP = 200;

/**
 * @param {{nodes: object[], edges: object[]}} old 既有 canvas JSON
 * @param {{
 *   resolve: (path: string) => string | null,  // 筆記目前的路徑；刪掉了回 null
 *   picks: string[],                           // 這次挑到的相關筆記（越相關越前面）
 *   relations: Array<{from, to, label?, color?}>,
 *   cardSize: {width, height},
 *   budget: number,                            // 整張圖的節點上限
 * }} input
 * @returns {{ canvas: object, added: string[], skipped: number, moved: number, removed: number, edgesAdded: number }}
 */
export function mergeRelationCanvas(old, { resolve, picks, relations, cardSize, budget }) {
  let moved = 0;
  const removedIds = new Set();
  const nodes = [];
  for (const node of old.nodes || []) {
    if (node.type !== "file" || !node.file.endsWith(".md")) {
      nodes.push(node);
      continue;
    }
    const current = resolve(node.file);
    if (!current) removedIds.add(node.id);
    else if (current !== node.file) {
      moved++;
      nodes.push({ ...node, file: current });
    } else nodes.push(node);
  }
  const edges = (old.edges || []).filter((e) => !removedIds.has(e.fromNode) && !removedIds.has(e.toNode));

  const nodeOf = new Map(nodes.filter((n) => n.type === "file").map((n) => [n.file, n.id]));
  const room = Math.max(0, budget - nodes.length - 1); // -1：新增群組框本身
  const missing = picks.filter((p) => !nodeOf.has(p));
  const added = missing.slice(0, room);

  const canvas = createCanvas({ nodes, edges });
  if (added.length) {
    const { group, items } = clusterLayout({ center: { width: 0, height: 0 }, clusters: [added.map(() => cardSize)] }).clusters[0];
    const right = Math.max(0, ...nodes.map((n) => n.x + n.width));
    const top = nodes.length ? Math.min(...nodes.map((n) => n.y)) : 0;
    const dx = right + NEW_GROUP_GAP - group.x;
    const dy = top - group.y;
    canvas.addGroup({ label: NEW_GROUP, ...group, x: group.x + dx, y: group.y + dy });
    added.forEach((file, i) => nodeOf.set(file, canvas.addFile({ file, ...items[i], x: items[i].x + dx, y: items[i].y + dy })));
  }

  const isNew = new Set(added);
  const linked = new Set(edges.map((e) => [e.fromNode, e.toNode].sort().join("|")));
  let edgesAdded = 0;
  for (const r of relations) {
    const from = nodeOf.get(r.from);
    const to = nodeOf.get(r.to);
    if (!from || !to || from === to) continue;
    if (!isNew.has(r.from) && !isNew.has(r.to)) continue;
    if (!r.label && isNew.has(r.from) && isNew.has(r.to)) continue; // 同在新增群裡的既有連結，跟首次建立一樣不畫
    const key = [from, to].sort().join("|");
    if (linked.has(key)) continue;
    linked.add(key);
    canvas.addEdge({ from, to, label: r.label, color: r.color });
    edgesAdded++;
  }

  return { canvas: canvas.toJSON(), added, skipped: missing.length - added.length, moved, removed: removedIds.size, edgesAdded };
}
