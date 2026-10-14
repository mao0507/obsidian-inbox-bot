// Canvas 排版：只算座標（左上角 x, y + width, height），不碰 canvas 格式本身。

const GAP_X = 120; // 欄與欄之間
const GAP_Y = 40; // 同一欄上下之間
const BLOCK_GAP_Y = 80; // 不同分支之間

const GROUP_PADDING = 40;
const GROUP_LABEL_SPACE = 30; // Obsidian 群組框的標題畫在框的上緣
const ROW_GAP_Y = 100;

/**
 * 流程圖（規劃圖）：最上面一張標題卡；每個階段一列、用群組框包起來，由上往下排；
 * 階段內的步驟由左到右排，每個步驟引用的筆記卡掛在它正下方。每列水平置中。
 *
 * @param {{ header: {width,height}, phases: Array<{ steps: Array<{ size: {width,height}, leaves: Array<{width,height}> }> }> }} input
 * @returns {{ header: Box, phases: Array<{ group: Box, steps: Array<{ box: Box, leaves: Box[] }> }> }}
 */
export function flowLayout({ header, phases }) {
  const headerBox = { x: -header.width / 2, y: 0, width: header.width, height: header.height };
  let y = headerBox.height + ROW_GAP_Y;

  const laidOut = phases.map(({ steps }) => {
    const columns = steps.map(({ size, leaves }) => {
      const width = Math.max(size.width, ...leaves.map((l) => l.width));
      const height = size.height + leaves.reduce((h, l) => h + GAP_Y + l.height, 0);
      return { width, height };
    });
    const contentWidth = columns.reduce((w, c) => w + c.width, 0) + Math.max(0, columns.length - 1) * GAP_X;
    const contentHeight = Math.max(0, ...columns.map((c) => c.height));
    const top = y + GROUP_PADDING + GROUP_LABEL_SPACE;
    let x = -contentWidth / 2;

    const stepBoxes = steps.map(({ size, leaves }, i) => {
      const colWidth = columns[i].width;
      const box = { x: x + (colWidth - size.width) / 2, y: top, width: size.width, height: size.height };
      let leafY = top + size.height + GAP_Y;
      const leafBoxes = leaves.map((leaf) => {
        const leafBox = { x: x + (colWidth - leaf.width) / 2, y: leafY, width: leaf.width, height: leaf.height };
        leafY += leaf.height + GAP_Y;
        return leafBox;
      });
      x += colWidth + GAP_X;
      return { box, leaves: leafBoxes };
    });

    const group = {
      x: -contentWidth / 2 - GROUP_PADDING,
      y,
      width: contentWidth + GROUP_PADDING * 2,
      height: contentHeight + GROUP_PADDING * 2 + GROUP_LABEL_SPACE,
    };
    y += group.height + ROW_GAP_Y;
    return { group, steps: stepBoxes };
  });

  return { header: headerBox, phases: laidOut };
}

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
