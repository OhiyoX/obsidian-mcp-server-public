// Stable public entrypoint. Implementation lives in focused modules under
// create-editor.js and extensions/ so callers do not depend on internal layout.
export { createObsidianEditor } from "./create-editor.js";
export {
  codeBlockNewlineSpec,
  liveNewlineSpec,
  newlineInCodeBlock,
  newlineInLive,
  shouldCollapsePaddingNewline,
  snapHiddenChromeCaret,
  fenceLineInsertPos,
} from "./extensions/commands.js";

