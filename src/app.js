// Composition root：唯一把 config.js（.env）接到各個深 module 的地方。
// 深 module 本身（noteStore.js 等）不 import config，測試可以直接傳自己的參數建立。
import { VAULT_PATH } from "./config.js";
import { createNoteStore } from "./noteStore.js";

export const vault = createNoteStore(VAULT_PATH);
