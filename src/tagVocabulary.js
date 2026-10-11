// Tag 詞彙表：vault 裡所有 tag 的「標準寫法 + 別名」，存在 vault 的 _系統/tags.json（跟著 vault 用 git 同步，
// 換電腦、換作業系統都帶得走；使用者也可以直接編輯這個檔案增減別名）。
//
// 格式：{ "tags": { "標準寫法": ["別名", ...] } }
//
// AI 回傳的 tag 一律經過這裡正規化：大小寫、空白、- _ . 不同的寫法視為同一個（Claude Code = claude-code = ClaudeCode），
// 語意上的別名（Vue3 → Vue）靠別名清單。找不到的才建立新 tag，並回報給使用者（Telegram 回覆裡的 🆕）。
//
// ponytail: 讀-改-寫沒有鎖；一般收件那條佇列是循序的，只有研究那條同時寫入時才可能互蓋，最壞情況是少記一個新 tag。

const VOCAB_PATH = "_系統/tags.json";

// 內建的常見別名，跟 tags.json 合併（tags.json 裡的設定優先）。
const SEED_ALIASES = {
  Vue: ["Vue3", "Vue2"],
  React: ["ReactJS"],
  JavaScript: ["JS"],
  TypeScript: ["TS"],
  NodeJS: ["Node"],
  PostgreSQL: ["Postgres", "PG"],
};

/** 比對用的 key：不分大小寫，忽略空白與 - _ . # 。 */
export function tagKey(tag) {
  return String(tag)
    .toLowerCase()
    .replace(/[\s\-_.#]/g, "");
}

// Obsidian 的 tag 不能有空白，# 是語法字元
const cleanTag = (tag) => String(tag).replace(/^#/, "").replace(/\s+/g, "").trim();

export function createTagVocabulary(vault) {
  let tags = loadTags();
  let index = buildIndex(tags);

  function loadTags() {
    let fromFile = {};
    try {
      fromFile = JSON.parse(vault.readFile(VOCAB_PATH) || "{}").tags || {};
    } catch (err) {
      console.warn(`[tags] ${VOCAB_PATH} 格式錯誤，暫時忽略：${err.message}`);
    }
    const merged = { ...SEED_ALIASES };
    for (const [canonical, aliases] of Object.entries(fromFile)) {
      merged[canonical] = [...new Set([...(merged[canonical] || []), ...(Array.isArray(aliases) ? aliases : [])])];
    }
    return merged;
  }

  function buildIndex(map) {
    const idx = new Map();
    for (const [canonical, aliases] of Object.entries(map)) {
      for (const name of [canonical, ...aliases]) idx.set(tagKey(name), canonical);
    }
    return idx;
  }

  function save() {
    const sorted = Object.fromEntries(Object.entries(tags).sort(([a], [b]) => a.localeCompare(b, "zh-Hant")));
    vault.writeFile(VOCAB_PATH, `${JSON.stringify({ tags: sorted }, null, 2)}\n`);
  }

  return {
    /**
     * 把一串 tag 換成標準寫法（去重、保留順序）；詞彙表沒有的建立成新 tag 並寫回檔案。
     * @returns {{ tags: string[], created: string[] }}
     */
    resolve(rawTags) {
      const result = [];
      const created = [];
      for (const raw of rawTags || []) {
        const clean = cleanTag(raw);
        if (!clean) continue;
        let canonical = index.get(tagKey(clean));
        if (!canonical) {
          canonical = clean;
          tags = { ...tags, [canonical]: [] };
          index.set(tagKey(canonical), canonical);
          created.push(canonical);
        }
        if (!result.includes(canonical)) result.push(canonical);
      }
      if (created.length) save();
      return { tags: result, created };
    },

    /** 把 from 這個 tag 併進 into：from 與它的別名都變成 into 的別名，之後寫 from 會自動變成 into。 */
    mergeInto(from, into) {
      const { [from]: fromAliases = [], ...rest } = tags;
      tags = { ...rest, [into]: [...new Set([...(rest[into] || []), from, ...fromAliases])] };
      index = buildIndex(tags);
      save();
    },

    /** 查標準寫法，不建立新 tag；找不到回傳 null（概念卡比對名稱時用）。 */
    lookup(name) {
      return index.get(tagKey(cleanTag(name))) || null;
    },

    /** 所有標準寫法（給 prompt 用） */
    list() {
      return Object.keys(tags).sort((a, b) => a.localeCompare(b, "zh-Hant"));
    },
  };
}
