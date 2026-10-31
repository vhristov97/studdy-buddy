import { describe, expect, it } from "vitest";
import { job } from "../test/utils";
import { groupJobs, jobLabel, mergeJobs, stageLabel } from "./pipeline";

describe("mergeJobs", () => {
  it("lets the live copy win and sorts newest first", () => {
    const fetched = [job({ id: 1, status: "failed" }), job({ id: 2 })];
    const live = new Map([[2, job({ id: 2, status: "succeeded" })]]);
    const merged = mergeJobs(fetched, live, 5);
    expect(merged.map((j) => [j.id, j.status])).toEqual([
      [2, "succeeded"],
      [1, "failed"],
    ]);
  });

  it("does not let a stale 'running' copy override a finished job", () => {
    const merged = mergeJobs(
      [job({ status: "succeeded" })],
      new Map([[1, job({ status: "running" })]]),
      5,
    );
    expect(merged[0]?.status).toBe("succeeded");
  });

  it("adds live jobs the query does not know yet and ignores other classes", () => {
    const live = new Map([
      [7, job({ id: 7 })],
      [8, job({ id: 8, classId: 6 })],
    ]);
    expect(mergeJobs([], live, 5).map((j) => j.id)).toEqual([7]);
  });
});

describe("groupJobs", () => {
  it("puts the newest job of a kind first and the rest in earlier", () => {
    const [group] = groupJobs([job({ id: 3 }), job({ id: 2 }), job({ id: 1 })]);
    expect(group?.latest.id).toBe(3);
    expect(group?.earlier.map((j) => j.id)).toEqual([2, 1]);
  });
});

describe("groupJobs grading", () => {
  it("makes one group per graded submission, newest first, after the quiz", () => {
    const groups = groupJobs([
      job({ id: 7, kind: "grading", submissionId: 9 }),
      job({ id: 6, kind: "grading", submissionId: 10 }),
      job({ id: 5, kind: "grading", submissionId: 9 }),
      job({ id: 2, kind: "quiz" }),
    ]);
    expect(groups.map((g) => [g.kind, g.latest.id, g.earlier.length])).toEqual([
      ["quiz", 2, 0],
      ["grading", 7, 1],
      ["grading", 6, 0],
    ]);
    expect(new Set(groups.map((g) => g.key)).size).toBe(3);
  });
});

describe("groupJobs order", () => {
  it("lists the lesson before the quiz regardless of ids", () => {
    const groups = groupJobs([job({ id: 9, kind: "quiz" }), job({ id: 3, kind: "lesson" })]);
    expect(groups.map((g) => g.kind)).toEqual(["lesson", "quiz"]);
  });
});

describe("stageLabel", () => {
  it("labels the quiz steps and nothing else", () => {
    expect(stageLabel({ stage: "quiz-planner", cycle: null })).toBe("Planiranje");
    expect(stageLabel({ stage: "quiz-builder", cycle: null })).toBe("Izrada");
    expect(stageLabel({ stage: "quiz-builder", cycle: 3 })).toBe("Ispravke (krug 3)");
    expect(stageLabel({ stage: "quiz-reviewer", cycle: 2 })).toBe("Provera (krug 2)");
    expect(stageLabel({ stage: "viz-planner", cycle: null })).toBe("Planiranje");
    expect(stageLabel({ stage: "viz-builder", cycle: null })).toBe("Izrada");
    expect(stageLabel({ stage: "viz-builder", cycle: 1 })).toBe("Ispravke (krug 1)");
    expect(stageLabel({ stage: "viz-reviewer", cycle: 2 })).toBe("Provera (krug 2)");
    expect(stageLabel({ stage: "lesson-writer", cycle: null })).toBeNull();
  });
});

describe("groupJobs viz", () => {
  it("groups viz jobs per suggestion, in suggestion order after the other kinds", () => {
    const groups = groupJobs([
      job({ id: 9, kind: "viz", suggestionId: 2 }),
      job({ id: 8, kind: "viz", suggestionId: 1 }),
      job({ id: 7, kind: "viz", suggestionId: 2, status: "failed" }),
      job({ id: 6, kind: "viz_topics" }),
    ]);
    expect(groups.map((g) => [g.kind, g.suggestionId, g.latest.id, g.earlier.length])).toEqual([
      ["viz_topics", null, 6, 0],
      ["viz", 1, 8, 0],
      ["viz", 2, 9, 1],
    ]);
  });
});

describe("groupJobs cumulative quizzes", () => {
  it("keeps K jobs apart from the class's own quiz, one group per code, after the quiz", () => {
    const groups = groupJobs([
      job({ id: 9, kind: "quiz", quizCode: "K10" }),
      job({ id: 8, kind: "quiz", quizCode: "K2" }),
      job({ id: 7, kind: "quiz", quizCode: "K2" }),
      job({ id: 3, kind: "quiz", quizCode: null }),
      job({ id: 1 }),
    ]);
    expect(groups.map((g) => [g.kind, g.quizCode, g.latest.id, g.earlier.length])).toEqual([
      ["lesson", null, 1, 0],
      ["quiz", null, 3, 0],
      ["quiz", "K2", 8, 1],
      ["quiz", "K10", 9, 0],
    ]);
  });
});

describe("jobLabel", () => {
  it("labels a cumulative quiz job with its code", () => {
    expect(jobLabel(job({ kind: "quiz", quizCode: "K1" }))).toBe("Kumulativni test K1");
    expect(jobLabel(job({ kind: "quiz", quizCode: null }))).toBe("Kviz");
  });

  it("names the topic of a viz job when known", () => {
    const concepts = new Map([[1, "Sharding"]]);
    expect(jobLabel(job({ kind: "viz", suggestionId: 1 }), concepts)).toBe(
      "Vizualizacija: Sharding",
    );
    expect(jobLabel(job({ kind: "viz", suggestionId: 2 }), concepts)).toBe("Vizualizacija");
    expect(jobLabel(job({ kind: "viz_topics" }), concepts)).toBe("Predlozi vizualizacija");
  });
});
