import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createNotebookResearch, NotebookAuthExpiredError } from "../src/notebookResearch.js";

// 照劇本回應的假 notebooklm CLI：handlers 依子指令決定回應，所有呼叫記在 calls 裡。
function fakeRun(overrides = {}) {
  const calls = [];
  const handlers = {
    create: () => JSON.stringify({ notebook: { id: "nb1" } }),
    "source add": () => JSON.stringify({ source: { id: "src1" } }),
    "source wait": () => "",
    "source add-research": () => "",
    ask: () => JSON.stringify({ answer: "影片在講量子運算" }),
    "generate report": () => "",
    "download report": (args) => {
      fs.writeFileSync(args[2], "# 報告內容");
      return "";
    },
    "auth refresh": () => "",
    login: () => "ok",
    ...overrides,
  };
  const run = async (args) => {
    calls.push(args);
    const key = [`${args[0]} ${args[1]}`, args[0]].find((k) => k in handlers);
    return handlers[key](args);
  };
  return { run, calls };
}

const fakeAi = (brief = "清楚的研究說明") => ({ ask: async () => brief });
const researchArg = (calls) => calls.find((a) => a[1] === "add-research")[2];

test("pure URL: adds as source and researches the described topic, not the URL", async () => {
  const { run, calls } = fakeRun();
  let asked = false;
  const nb = createNotebookResearch({ run, ai: { ask: async () => ((asked = true), "x") } });

  const result = await nb.researchTopic("https://youtu.be/abc");

  assert.equal(asked, false, "URL topics must not be summarized by AI");
  assert.deepEqual(calls.find((a) => a[1] === "add").slice(0, 3), ["source", "add", "https://youtu.be/abc"]);
  assert.equal(researchArg(calls), "影片在講量子運算");
  assert.deepEqual(result, { notebookId: "nb1", reportText: "# 報告內容", effectiveTopic: "影片在講量子運算" });
});

test("text with embedded URL: AI brief drives research, URL still added as source", async () => {
  const { run, calls } = fakeRun();
  const nb = createNotebookResearch({ run, ai: fakeAi() });

  await nb.researchTopic("幫我研究 https://a.com/x。順便比較");

  assert.equal(researchArg(calls), "清楚的研究說明");
  assert.equal(calls.find((a) => a[1] === "add")[2], "https://a.com/x");
});

test("auth expired: refresh succeeds then the flow is retried once", async () => {
  let failed = false;
  const { run, calls } = fakeRun({
    create: () => {
      if (!failed) {
        failed = true;
        throw new NotebookAuthExpiredError();
      }
      return JSON.stringify({ notebook: { id: "nb2" } });
    },
  });
  const statuses = [];
  const nb = createNotebookResearch({ run, ai: fakeAi() });

  const result = await nb.researchTopic("主題", { onStatus: (s) => statuses.push(s) });

  assert.equal(result.notebookId, "nb2");
  assert.ok(calls.some((a) => a[0] === "auth"));
  assert.equal(statuses.length, 1);
});

test("auth expired and every recovery fails: original auth error surfaces", async () => {
  const fail = () => {
    throw new Error("nope");
  };
  const { run, calls } = fakeRun({
    create: () => {
      throw new NotebookAuthExpiredError();
    },
    "auth refresh": fail,
    login: fail,
  });
  const nb = createNotebookResearch({ run, ai: fakeAi(), loginBrowser: "chrome" });

  await assert.rejects(nb.researchTopic("主題"), NotebookAuthExpiredError);
  assert.equal(calls.filter((a) => a[0] === "auth").length, 2, "quiet refresh + browser-cookies");
  assert.ok(calls.some((a) => a[0] === "login"));
});

const plan = { question: "台灣離岸風電的發展瓶頸與機會", angles: ["政策與躉購費率", "供應鏈國產化", "併網與電網限制"] };

test("with a plan: researches the plan question in deep mode, no AI brief needed", async () => {
  const { run, calls } = fakeRun();
  let asked = false;
  const nb = createNotebookResearch({ run, ai: { ask: async () => ((asked = true), "x") } });

  const result = await nb.researchTopic("離岸風電", { plan });

  assert.equal(asked, false);
  const research = calls.find((a) => a[1] === "add-research");
  assert.equal(research[2], plan.question);
  assert.equal(research[research.indexOf("--mode") + 1], "deep");
  assert.equal(result.effectiveTopic, plan.question);
});

test("report is a custom zh_Hant report whose prompt walks through every planned angle", async () => {
  let promptText = "";
  const { run, calls } = fakeRun({
    "generate report": (args) => {
      promptText = fs.readFileSync(args[args.indexOf("--prompt-file") + 1], "utf8");
      return "";
    },
  });
  await createNotebookResearch({ run, ai: fakeAi() }).researchTopic("離岸風電", { plan });

  const report = calls.find((a) => a[0] === "generate");
  assert.equal(report[report.indexOf("--format") + 1], "custom");
  assert.equal(report[report.indexOf("--language") + 1], "zh_Hant");
  assert.match(promptText, /台灣離岸風電的發展瓶頸與機會/);
  for (const angle of plan.angles) assert.ok(promptText.includes(angle), angle);
  assert.match(promptText, /引用/);
});

test("supplementResearch deepens an existing notebook without creating a new one", async () => {
  const { run, calls } = fakeRun();
  const result = await createNotebookResearch({ run, ai: fakeAi() }).supplementResearch("nb-existing", plan);

  assert.equal(calls.some((a) => a[0] === "create"), false);
  const research = calls.find((a) => a[1] === "add-research");
  assert.equal(research[2], plan.question);
  assert.equal(research[research.indexOf("-n") + 1], "nb-existing");
  assert.deepEqual(result, { notebookId: "nb-existing", reportText: "# 報告內容" });
});

test("supplementResearch also recovers from an expired login", async () => {
  let failed = false;
  const { run } = fakeRun({
    "source add-research": () => {
      if (!failed) {
        failed = true;
        throw new NotebookAuthExpiredError();
      }
      return "";
    },
  });
  const result = await createNotebookResearch({ run, ai: fakeAi() }).supplementResearch("nb-existing", plan);
  assert.equal(result.reportText, "# 報告內容");
});
