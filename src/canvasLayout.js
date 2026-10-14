// Canvas 排版：只算座標（左上角 x, y + width, height），不碰 canvas 格式本身。

const GAP_X = 120; // 欄與欄之間
const GAP_Y = 40; // 同一欄上下之間
const BLOCK_GAP_Y = 80; // 不同分支之間

/**
 * 心智圖：中心在中間，分支輪流放右、左兩側並各自由上往下堆疊，每個分支的葉子（筆記卡）放在它外側那一欄。
 * 每個分支佔一個區塊（高度 = 分支卡與其葉子較高者），區塊之間不重疊，所以整張圖保證不重疊。
 *
 * @param {{ center: {width,height}, branches: Array<{ size: {width,height}, leaves: Array<{width,height}> }> }} input
 * @returns {{ center: Box, branches: Array<{ box: Box, leaves: Box[] }> }}
 */
export function mindMapLayout({ center, branches }) {
  const sides = { right: [], left: [] };
  branches.forEach((branch, i) => sides[i % 2 === 0 ? "right" : "left"].push({ branch, index: i }));

  const blockHeight = ({ size, leaves }) => {
    const leavesHeight = leaves.reduce((h, leaf) => h + leaf.height, 0) + Math.max(0, leaves.length - 1) * GAP_Y;
    return Math.max(size.height, leavesHeight);
  };

  const centerBox = { x: -center.width / 2, y: -center.height / 2, width: center.width, height: center.height };
  const result = new Array(branches.length);

  for (const [side, items] of Object.entries(sides)) {
    if (!items.length) continue;
    const dir = side === "right" ? 1 : -1;
    const branchWidth = Math.max(...items.map((it) => it.branch.size.width));
    const totalHeight = items.reduce((h, it) => h + blockHeight(it.branch), 0) + (items.length - 1) * BLOCK_GAP_Y;
    // 分支欄緊貼中心卡外側；葉子欄再往外一欄
    const branchX = dir > 0 ? centerBox.x + centerBox.width + GAP_X : centerBox.x - GAP_X - branchWidth;
    let y = -totalHeight / 2;

    for (const { branch, index } of items) {
      const height = blockHeight(branch);
      const box = {
        x: branchX + (branchWidth - branch.size.width) / 2,
        y: y + (height - branch.size.height) / 2,
        width: branch.size.width,
        height: branch.size.height,
      };
      const leavesHeight = branch.leaves.reduce((h, leaf) => h + leaf.height, 0) + Math.max(0, branch.leaves.length - 1) * GAP_Y;
      let leafY = y + (height - leavesHeight) / 2;
      const leaves = branch.leaves.map((leaf) => {
        const leafX = dir > 0 ? branchX + branchWidth + GAP_X : branchX - GAP_X - leaf.width;
        const leafBox = { x: leafX, y: leafY, width: leaf.width, height: leaf.height };
        leafY += leaf.height + GAP_Y;
        return leafBox;
      });
      result[index] = { box, leaves };
      y += height + BLOCK_GAP_Y;
    }
  }

  return { center: centerBox, branches: result };
}
