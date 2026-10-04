import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PRACTICAL_PHOTO_BASE64_CHARS,
  RetoolingValidationError,
  canCompleteRetoolingModule,
  gradeRetoolingQuiz,
  isValidPracticalPhotoBase64,
  validateQuizQuestionSet,
} from "../src/retooling-domain.ts";

const questions = [
  { q: "Question 1", options: ["A", "B", "C", "D"], correct: 0 },
  { q: "Question 2", options: ["A", "B", "C", "D"], correct: 1 },
  { q: "Question 3", options: ["A", "B", "C", "D"], correct: 2 },
  { q: "Question 4", options: ["A", "B", "C", "D"], correct: 3 },
  { q: "Question 5", options: ["A", "B", "C", "D"], correct: 0 },
];

test("accepts exactly five questions with four valid options and an answer key", () => {
  assert.equal(validateQuizQuestionSet(questions).length, 5);
  assert.throws(
    () => validateQuizQuestionSet([{ ...questions[0], options: ["A"] }]),
    RetoolingValidationError,
  );
  assert.throws(
    () => validateQuizQuestionSet([{ ...questions[0], correct: 4 }]),
    RetoolingValidationError,
  );
  assert.deepEqual(validateQuizQuestionSet([], true), []);
});

test("grades quizzes and calculates the 80 percent pass boundary", () => {
  const passing = gradeRetoolingQuiz(questions, [0, 1, 2, 3, 1]);
  assert.equal(passing.score, 80);
  assert.deepEqual(passing.correctAnswers, [0, 1, 2, 3, 0]);
  assert.equal(gradeRetoolingQuiz(questions, [1, 1, 2, 3, 1]).score, 60);
  assert.throws(() => gradeRetoolingQuiz(questions, [0, 1]), RetoolingValidationError);
});

test("requires video, quiz, practical evidence, and an acknowledgement for a configured PDF", () => {
  const complete = {
    started: true,
    quizPassed: true,
    hasPracticalPhoto: true,
    pdfConfigured: true,
    pdfRead: true,
  };
  assert.equal(canCompleteRetoolingModule(complete), true);
  assert.equal(canCompleteRetoolingModule({ ...complete, pdfRead: false }), false);
  assert.equal(canCompleteRetoolingModule({ ...complete, started: false }), false);
  assert.equal(canCompleteRetoolingModule({ ...complete, quizPassed: false }), false);
  assert.equal(canCompleteRetoolingModule({ ...complete, hasPracticalPhoto: false }), false);
  assert.equal(
    canCompleteRetoolingModule({ ...complete, pdfConfigured: false, pdfRead: false }),
    true,
  );
});

test("validates image data URLs and rejects malformed or oversized base64", () => {
  assert.equal(isValidPracticalPhotoBase64("data:image/jpeg;base64,AAAA"), true);
  assert.equal(isValidPracticalPhotoBase64("data:image/svg+xml;base64,AAAA"), false);
  assert.equal(isValidPracticalPhotoBase64("data:image/png;base64,ABC"), false);
  assert.equal(
    isValidPracticalPhotoBase64(
      `data:image/jpeg;base64,${"A".repeat(MAX_PRACTICAL_PHOTO_BASE64_CHARS)}`,
    ),
    false,
  );
});