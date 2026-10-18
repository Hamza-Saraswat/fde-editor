// Contract types, re-exported for the UI. Types only: nothing here reaches the browser bundle.
export type {
  Health, ScriptEntry, FileEntry, FileListing, CreateProjectBody, PatchProjectBody, PatchClipBody, GraphicState, GraphicStatus,
  Outputs, ProjectBundle, StageOptions, RunStageBody, JobInfo, SaveEditBody, SaveEditResponse, SaveEditConflict, SetStyleBody,
  PatchAssetBody, ServerEvent,
} from "../../src/server/api.ts";
export type {
  Asset, Candidates, Clip, Config, Cue, Cut, CutReason, Edit, EditStyle, FillerCandidate, Overlay, PlacedOverlay, Project, Rect,
  ScriptDoc, Section, Segment, Sentence, StageName, StageStatus, TakeGroup, TakeOption, Timeline, Transcript, Word,
} from "../../src/core/schema.ts";
export type { ClaudeEvent } from "../../src/claude/runner.ts";

export type SpeakerSide = "left" | "right" | "center";
export type Layout = "side" | "split" | "full";
export type Side = "left" | "right";
