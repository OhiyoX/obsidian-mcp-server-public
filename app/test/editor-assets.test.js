import assert from "node:assert/strict";
import test from "node:test";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import {
  createLiveBlockPreview,
  liveMetaField,
  setLiveDocumentContext,
} from "../frontend/app/features/editor/live-preview.js";
import { interactionField } from "../frontend/app/features/editor/interaction.js";
import { assetKey } from "../frontend/app/features/editor/markdown-model.js";

test("refreshAssets matches canonical vault path and updates revision map", () => {
  let closureRevisions = {};
  const preview = createLiveBlockPreview(() => ({
    sourcePath: "notes/demo.md",
    vaultId: "vault-a",
    assetRevisions: closureRevisions,
  }));

  let state = EditorState.create({
    doc: "![pic](../images/pic.png)\n",
    extensions: [markdown({ extensions: GFM }), interactionField, ...preview.extension],
  });
  state = state.update({
    effects: setLiveDocumentContext.of({
      sourcePath: "notes/demo.md",
      vaultId: "vault-a",
      documentContext: null,
      envVersion: "1",
      dependencies: ["images/pic.png"],
      assetRevisions: {},
    }),
  }).state;

  const view = {
    get state() { return state; },
    dispatch(spec) { state = state.update(spec).state; },
  };

  assert.equal(
    preview.refreshAssets(view, { vaultId: "vault-a", path: "images/pic.png", revision: "r9" }),
    true,
  );
  assert.equal(state.field(liveMetaField).assetRevisions[assetKey("vault-a", "images/pic.png")], "r9");
  // Caller (editor.refreshAssets) is responsible for mirroring into closure.
  closureRevisions = { ...state.field(liveMetaField).assetRevisions };
  assert.equal(closureRevisions[assetKey("vault-a", "images/pic.png")], "r9");

  // syncContext must preserve closure revisions (not reset to empty).
  preview.syncContext(view);
  assert.equal(state.field(liveMetaField).assetRevisions[assetKey("vault-a", "images/pic.png")], "r9");

  assert.equal(
    preview.refreshAssets(view, { vaultId: "other", path: "images/pic.png", revision: "r10" }),
    false,
  );
  assert.equal(preview.refreshAssets(view, { vaultId: "vault-a", path: "root-fallback/pic.png", revision: "fallback-v2" }), true);
  assert.equal(state.field(liveMetaField).assetRevisions[assetKey("vault-a", "images/pic.png")], "fallback-v2");
  assert.equal(preview.refreshAssets(view, { vaultId: "vault-a", path: "unrelated.txt", revision: "r11" }), false);
});

test("setLiveDocumentContext keeps prior assetRevisions when omitted", () => {
  const preview = createLiveBlockPreview(() => ({
    sourcePath: "a.md",
    vaultId: "v",
    assetRevisions: { "v::pic.png": "1" },
  }));
  let state = EditorState.create({
    doc: "hi",
    extensions: [markdown({ extensions: GFM }), interactionField, ...preview.extension],
  });
  state = state.update({
    effects: setLiveDocumentContext.of({
      sourcePath: "a.md",
      vaultId: "v",
      assetRevisions: { "v::pic.png": "1" },
      envVersion: "1",
    }),
  }).state;
  state = state.update({
    effects: setLiveDocumentContext.of({
      sourcePath: "a.md",
      vaultId: "v",
      documentContext: null,
      envVersion: "2",
    }),
  }).state;
  assert.equal(state.field(liveMetaField).assetRevisions["v::pic.png"], "1");
});
