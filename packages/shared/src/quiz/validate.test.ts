import { describe, expect, it } from "vitest";
import { validQuiz } from "./fixtures";
import { formatQuizReport, validateQuiz, validateQuizLibrary } from "./validate";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const clone = (): Json => structuredClone(validQuiz);

/** Applies a mutation to a fresh quiz and returns the report. */
function check(mutate: (quiz: Json) => void, opts?: Parameters<typeof validateQuiz>[1]) {
  const quiz = clone();
  mutate(quiz);
  return validateQuiz(quiz, opts);
}

const errorAt = (report: ReturnType<typeof validateQuiz>, code: string, path: string) =>
  report.errors.find((e) => e.code === code && e.path === path);

describe("validateQuiz: quiz level", () => {
  it("passes a valid quiz with no errors or warnings", () => {
    const report = validateQuiz(clone());
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it("rejects non-objects", () => {
    for (const input of [null, undefined, 3, "x", []]) {
      expect(validateQuiz(input).errors.map((e) => e.code)).toEqual(["quiz_not_object"]);
    }
  });

  it.each(["code", "title", "subtitle"])("flags a missing or empty %s", (field) => {
    expect(
      errorAt(
        check((q) => delete q[field]),
        `missing_${field}`,
        field,
      ),
    ).toBeDefined();
    expect(
      errorAt(
        check((q) => (q[field] = "  ")),
        `missing_${field}`,
        field,
      ),
    ).toBeDefined();
  });

  it("flags invalid chips", () => {
    for (const chips of [undefined, [], "x", ["ok", ""], [1]]) {
      expect(
        errorAt(
          check((q) => (q.chips = chips)),
          "invalid_chips",
          "chips",
        ),
      ).toBeDefined();
    }
  });

  it("flags missing or empty questions", () => {
    expect(
      errorAt(
        check((q) => delete q.questions),
        "missing_questions",
        "questions",
      ),
    ).toBeTruthy();
    expect(
      errorAt(
        check((q) => (q.questions = [])),
        "missing_questions",
        "questions",
      ),
    ).toBeTruthy();
  });

  it("flags a code already in the library", () => {
    const report = check(() => {}, { existingCodes: new Set(["K1", "P01"]) });
    expect(errorAt(report, "duplicate_quiz_code", "code")).toBeDefined();
    expect(check(() => {}, { existingCodes: ["P02"] }).errors).toEqual([]);
  });
});

describe("validateQuiz: all questions", () => {
  it("flags a non-object question", () => {
    const report = check((q) => (q.questions[0] = "x"));
    expect(errorAt(report, "question_not_object", "questions[0]")).toBeDefined();
  });

  it("flags a missing or empty id and carries the question id on other issues", () => {
    expect(
      errorAt(
        check((q) => delete q.questions[1].id),
        "missing_id",
        "questions[1].id",
      ),
    ).toBeTruthy();
    expect(
      errorAt(
        check((q) => (q.questions[1].id = "")),
        "missing_id",
        "questions[1].id",
      ),
    ).toBeTruthy();
    const report = check((q) => delete q.questions[0].prompt);
    expect(errorAt(report, "missing_prompt", "questions[0].prompt")?.questionId).toBe("q1");
  });

  it("flags duplicate question ids", () => {
    const report = check((q) => (q.questions[2].id = "q1"));
    expect(errorAt(report, "duplicate_question_id", "questions[2].id")).toBeDefined();
  });

  it("flags an unknown type", () => {
    const report = check((q) => (q.questions[0].type = "essay"));
    expect(errorAt(report, "unknown_type", "questions[0].type")).toBeDefined();
  });

  it.each([
    ["prompt", "missing_prompt"],
    ["ref", "missing_ref"],
    ["topic", "missing_topic"],
  ])("flags a missing or empty %s", (field, code) => {
    expect(
      errorAt(
        check((q) => delete q.questions[3][field]),
        code,
        `questions[3].${field}`,
      ),
    ).toBeTruthy();
    expect(
      errorAt(
        check((q) => (q.questions[3][field] = " ")),
        code,
        `questions[3].${field}`,
      ),
    ).toBeTruthy();
  });

  it.each([0, 1, 2])("requires an explanation on closed question %i", (index) => {
    const report = check((q) => (q.questions[index].explanation = ""));
    expect(errorAt(report, "missing_explanation", `questions[${index}].explanation`)).toBeTruthy();
  });

  it("does not require an explanation on open questions", () => {
    expect(check((q) => delete q.questions[3].explanation).errors).toEqual([]);
  });
});

describe("validateQuiz: mc", () => {
  it("flags fewer than 2 options", () => {
    const report = check((q) => {
      q.questions[0].options = ["a"];
      q.questions[0].answer = 0;
    });
    expect(errorAt(report, "mc_options_count", "questions[0].options")).toBeDefined();
  });

  it("flags empty option text", () => {
    const report = check((q) => (q.questions[0].options[2] = " "));
    expect(errorAt(report, "mc_empty_option", "questions[0].options[2]")).toBeDefined();
  });

  it.each([-1, 3, 1.5, "1", null])("flags answer %j", (answer) => {
    const report = check((q) => (q.questions[0].answer = answer));
    expect(errorAt(report, "mc_answer_range", "questions[0].answer")).toBeDefined();
  });

  it("warns when the correct option is much longer than the others", () => {
    const report = check((q) => {
      q.questions[0].options = [
        "Kratko",
        "Takođe kratko",
        "Ovo je znatno duža tačna opcija nego ostale",
      ];
      q.questions[0].answer = 2;
    });
    expect(report.errors).toEqual([]);
    expect(report.warnings).toMatchObject([
      { code: "mc_correct_stands_out", path: "questions[0].options", questionId: "q1" },
    ]);
  });

  it("does not warn when option lengths are similar", () => {
    expect(check((q) => (q.questions[0].answer = 0)).warnings).toEqual([]);
  });

  it("counts correct positions per option index", () => {
    const report = check((q) => {
      const mc = (id: string, answer: number, count = 3) => ({
        ...q.questions[0],
        id,
        answer,
        options: Array.from({ length: count }, (_, i) => `opcija ${i}`),
      });
      q.questions.push(mc("q5", 0), mc("q6", 1), mc("q7", 3, 4));
    });
    expect(report.errors).toEqual([]);
    expect(report.mcAnswerPositions).toEqual([1, 2, 0, 1]);
  });

  it("reports no positions without mc questions", () => {
    expect(check((q) => (q.questions = [q.questions[3]])).mcAnswerPositions).toEqual([]);
  });
});

describe("validateQuiz: num", () => {
  it.each([undefined, "5", NaN, Infinity, null])("flags answer %j", (answer) => {
    const report = check((q) => (q.questions[1].answer = answer));
    expect(errorAt(report, "num_answer", "questions[1].answer")).toBeDefined();
  });

  it.each([undefined, "0.1", NaN, null])("flags tolerance %j", (tolerance) => {
    const report = check((q) => (q.questions[1].tolerance = tolerance));
    expect(errorAt(report, "num_tolerance", "questions[1].tolerance")).toBeDefined();
  });

  it("flags a negative tolerance", () => {
    const report = check((q) => (q.questions[1].tolerance = -0.1));
    expect(errorAt(report, "num_tolerance_negative", "questions[1].tolerance")).toBeDefined();
  });

  it("accepts zero tolerance", () => {
    expect(check((q) => (q.questions[1].tolerance = 0)).errors).toEqual([]);
  });

  it.each([null, "", undefined])("warns about a missing unit (%j)", (unit) => {
    const report = check((q) => (q.questions[1].unit = unit));
    expect(report.errors).toEqual([]);
    expect(report.warnings).toMatchObject([
      { code: "num_missing_unit", path: "questions[1].unit", questionId: "q2" },
    ]);
  });
});

describe("validateQuiz: match", () => {
  it("flags missing or empty rows and choices", () => {
    expect(
      errorAt(
        check((q) => (q.questions[2].rows = [])),
        "match_rows",
        "questions[2].rows",
      ),
    ).toBeTruthy();
    expect(
      errorAt(
        check((q) => delete q.questions[2].choices),
        "match_choices",
        "questions[2].choices",
      ),
    ).toBeTruthy();
  });

  it.each(["", "   ", 3, null])("flags an empty or non-string row %j", (value) => {
    const report = check((q) => (q.questions[2].rows[1] = value));
    expect(errorAt(report, "match_empty_row", "questions[2].rows[1]")).toBeDefined();
  });

  it.each(["", "   ", 3, null])("flags an empty or non-string choice %j", (value) => {
    const report = check((q) => (q.questions[2].choices[0] = value));
    expect(errorAt(report, "match_empty_choice", "questions[2].choices[0]")).toBeDefined();
  });

  it("flags an answer that is not an array of the row count", () => {
    for (const answer of [undefined, [1], [1, 0, 1], "10"]) {
      const report = check((q) => (q.questions[2].answer = answer));
      expect(errorAt(report, "match_answer_length", "questions[2].answer")).toBeDefined();
    }
  });

  it.each([2, -1, 0.5, "0", null])("flags answer entry %j", (entry) => {
    const report = check((q) => (q.questions[2].answer = [1, entry]));
    expect(errorAt(report, "match_answer_range", "questions[2].answer[1]")).toBeDefined();
  });

  it("warns when more than one row is on the diagonal", () => {
    const report = check((q) => {
      q.questions[2].rows = ["a", "b", "c"];
      q.questions[2].choices = ["x", "y", "z"];
      q.questions[2].answer = [0, 1, 0];
    });
    expect(report.errors).toEqual([]);
    expect(report.warnings).toMatchObject([
      { code: "match_diagonal", path: "questions[2].answer", questionId: "q3" },
    ]);
  });

  it("allows a single diagonal row", () => {
    const report = check((q) => (q.questions[2].answer = [0, 0]));
    expect(report.warnings).toEqual([]);
  });
});

describe("validateQuiz: open", () => {
  it.each([undefined, [], [""], "x"])("flags key points %j", (keyPoints) => {
    const report = check((q) => (q.questions[3].keyPoints = keyPoints));
    expect(errorAt(report, "open_key_points", "questions[3].keyPoints")).toBeDefined();
  });
});

describe("validateQuizLibrary", () => {
  it("flags duplicate codes across quizzes and prefixes paths", () => {
    const second = clone();
    delete second.questions[0].prompt;
    const report = validateQuizLibrary([clone(), second, { ...clone(), code: "P02" }]);
    expect(report.errors.map((e) => [e.code, e.path])).toEqual([
      ["duplicate_quiz_code", "quizzes[1].code"],
      ["missing_prompt", "quizzes[1].questions[0].prompt"],
    ]);
  });

  it("accepts distinct codes and sums mc positions", () => {
    const report = validateQuizLibrary([clone(), { ...clone(), code: "P02" }]);
    expect(report.errors).toEqual([]);
    expect(report.mcAnswerPositions).toEqual([0, 2, 0]);
  });

  it("reports non-object quizzes at their index", () => {
    expect(validateQuizLibrary([null]).errors).toMatchObject([
      { code: "quiz_not_object", path: "quizzes[0]" },
    ]);
  });
});

describe("formatQuizReport", () => {
  it("lists issues and mc positions compactly", () => {
    const report = check((q) => {
      delete q.questions[0].ref;
      q.questions[1].unit = null;
    });
    const text = formatQuizReport(report);
    expect(text).toContain("Errors (1):");
    expect(text).toContain("[missing_ref] q1 (questions[0].ref)");
    expect(text).toContain("Warnings (1):");
    expect(text).toContain("[num_missing_unit] q2 (questions[1].unit)");
    expect(text).toContain("#2: 1");
  });

  it("says none for a clean quiz", () => {
    const text = formatQuizReport(validateQuiz(clone()));
    expect(text).toContain("Errors (0):\n- none");
    expect(text).toContain("Warnings (0):\n- none");
  });
});
